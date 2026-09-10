package yolostart

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestImportWorkflow(t *testing.T) {
	for _, scenario := range []string{"success", "denied", "changed", "upload-failed", "seed-failed", "timeout", "ready-without-seed", "retry-create", "retry-finalize", "head-miss", "finalize-refused", "finalize-invalid", "finalize-throttled"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			put(t, root, "keep.txt", "approved content")
			put(t, root, "omit.txt", "do not send")
			put(t, root, ".env", "NEVER SEND")
			manifest, invs, e := scanImport(context.Background(), root, "")
			if e != nil {
				t.Fatal(e)
			}
			now := time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC)
			var log, out bytes.Buffer
			d := newImport(&log, "PRIVATE-TOKEN")
			d.now = func() time.Time { return now }
			d.sleep = func(ctx context.Context, delay time.Duration) error { now = now.Add(delay); return ctx.Err() }
			d.waitLimit = 5 * time.Second
			var announced struct {
				Bytes int64  `json:"bytes"`
				SHA   string `json:"sha256"`
			}
			var failure string
			polls, creates, finalizes, bundles := 0, 0, 0, 0
			var times []time.Time
			var server *httptest.Server
			server = httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strictJSONBody(w, r) {
					return
				}
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/put" {
					if r.Header.Get("Authorization") != "" || r.Header.Get("User-Agent") != "" || r.Header.Get("Accept-Encoding") != "" {
						t.Error("extra upload headers", r.Header)
					}
					if r.ContentLength != announced.Bytes || r.Header.Get("Content-Type") != "application/gzip" {
						t.Error("bad upload headers")
					}
					uploaded, _ := io.ReadAll(r.Body)
					sum := sha256.Sum256(uploaded)
					if hex.EncodeToString(sum[:]) != announced.SHA || base64.StdEncoding.EncodeToString(sum[:]) != r.Header.Get("X-Amz-Checksum-Sha256") {
						t.Error("checksum mismatch")
					}
					if scenario == "upload-failed" {
						w.WriteHeader(400)
						return
					}
					w.WriteHeader(200)
					return
				}
				if r.Header.Get("Authorization") != "Bearer PRIVATE-TOKEN" {
					t.Error("missing API auth")
				}
				switch r.Method + " " + r.URL.Path {
				case "POST /v1/yolostart/sessions":
					fmt.Fprint(w, `{"id":"session-1","status":"awaiting-approval"}`)
				case "GET /v1/yolostart/sessions/session-1":
					polls++
					if scenario == "denied" {
						fmt.Fprint(w, `{"status":"denied"}`)
						return
					}
					if creates == 0 {
						if scenario == "changed" {
							put(t, root, "keep.txt", "changed")
						}
						fmt.Fprint(w, `{"status":"approved","approval":{"candidateRelPath":".","workspaceName":"Chosen name","excludePaths":["omit.txt"]}}`)
						return
					}
					status := "pending"
					if scenario == "seed-failed" {
						status = "failed"
					} else if scenario != "timeout" && scenario != "ready-without-seed" && polls > 2 {
						status = "succeeded"
					}
					if scenario == "ready-without-seed" {
						fmt.Fprint(w, `{"status":"ready","workspaceId":"ws-1"}`)
						return
					}
					fmt.Fprintf(w, `{"status":"seeding","workspaceId":"ws-1","seed":{"status":%q,"reason":"fixture"}}`, status)
				case "PUT /v1/yolostart/sessions/session-1/progress":
					times = append(times, now)
					fmt.Fprint(w, `{}`)
				case "POST /v1/yolostart/sessions/session-1/bundle":
					bundles++
					_ = json.NewDecoder(r.Body).Decode(&announced)
					raw, _ := hex.DecodeString(announced.SHA)
					_ = json.NewEncoder(w).Encode(uploadGrant{BundleID: "bundle-1", UploadURL: server.URL + "/put", ExpiresAt: now.Add(15 * time.Minute), UploadHeaders: map[string]string{"Content-Type": "application/gzip", "Content-Length": fmt.Sprint(announced.Bytes), "x-amz-checksum-sha256": base64.StdEncoding.EncodeToString(raw)}})
				case "POST /v1/yolostart/sessions/session-1/bundle/finalize":
					finalizes++
					var body struct {
						BundleID string   `json:"bundleId"`
						Files    []string `json:"fileList"`
					}
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body.BundleID != "bundle-1" || strings.Join(body.Files, ",") != "keep.txt" {
						t.Error(body)
					}
					if scenario == "head-miss" && finalizes == 1 {
						w.WriteHeader(409)
						fmt.Fprint(w, `{"reason":"upload-not-arrived","message":"Object visibility is pending.","retryable":true}`)
						return
					}
					if scenario == "finalize-refused" || scenario == "finalize-invalid" || scenario == "finalize-throttled" {
						code, reason := 409, "approval-mismatch"
						if scenario == "finalize-throttled" {
							code, reason = 429, "rate-limit"
						}
						if scenario == "finalize-invalid" {
							code, reason = 400, "bundle-invalid"
						}
						w.WriteHeader(code)
						fmt.Fprintf(w, `{"reason":%q,"message":"server rejected archive","retryable":false}`, reason)
						return
					}
					if scenario == "retry-finalize" && finalizes == 1 {
						w.WriteHeader(503)
					}
					fmt.Fprint(w, `{}`)
				case "POST /v1/workspaces":
					creates++
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					if body["name"] != "Chosen name" || body["importBundleId"] != "bundle-1" {
						t.Error(body)
					}
					if scenario == "retry-create" && creates == 1 {
						w.WriteHeader(503)
					}
					fmt.Fprint(w, `{"id":"DO-NOT-TRUST-CREATE-RESPONSE"}`)
				case "POST /v1/yolostart/sessions/session-1/fail":
					var body map[string]string
					_ = json.NewDecoder(r.Body).Decode(&body)
					failure = body["reason"]
					if strings.Contains(body["message"], root) || strings.Contains(body["message"], "PRIVATE-TOKEN") {
						t.Error("private failure message")
					}
					fmt.Fprint(w, `{"status":"failed"}`)
				default:
					t.Error("unexpected request", r.Method, r.URL.Path)
					w.WriteHeader(404)
				}
			}))
			defer server.Close()
			d.base = server.URL + "/v1"
			d.client = server.Client()
			d.uploadClient = server.Client()
			// Match production: do not add gzip negotiation to the signed PUT.
			transport := d.uploadClient.Transport.(*http.Transport).Clone()
			transport.DisableCompression = true
			d.uploadClient = &http.Client{Transport: transport}
			err := d.execute(context.Background(), manifest, invs, &out)
			success := scenario == "success" || scenario == "retry-create" || scenario == "retry-finalize" || scenario == "head-miss"
			if success {
				if err != nil || out.String() != "https://yolo.studio/workspace?id=ws-1\n" {
					t.Fatal(out.String(), err)
				}
			} else if err == nil || out.Len() != 0 {
				t.Fatal("false success", out.String(), err)
			}
			if success && failure != "" {
				t.Fatal(failure)
			}
			if scenario == "changed" && (failure != "files-changed" || bundles != 0) {
				t.Fatal(failure, bundles)
			}
			if scenario == "upload-failed" && (failure != "upload-failed" || finalizes != 0 || creates != 0) {
				t.Fatal(failure, finalizes, creates)
			}
			if scenario == "finalize-refused" || scenario == "finalize-invalid" || scenario == "finalize-throttled" {
				if failure != "" || finalizes != 1 || creates != 0 || !strings.Contains(err.Error(), "server rejected archive") {
					t.Fatal(failure, finalizes, creates, err)
				}
			}
			if creates > 0 && failure != "" {
				t.Fatal("client overrode pod verdict")
			}
			if scenario == "retry-create" && creates != 2 {
				t.Fatal(creates)
			}
			if (scenario == "retry-finalize" || scenario == "head-miss") && finalizes != 2 {
				t.Fatal(finalizes)
			}
			for i := 1; i < len(times); i++ {
				if times[i].Sub(times[i-1]) < time.Second {
					t.Fatal("progress exceeds 1/s")
				}
			}
			if strings.Contains(log.String()+out.String(), "PRIVATE-TOKEN") {
				t.Fatal("token output")
			}
		})
	}
}
func TestUploadRejectsUnsafeGrant(t *testing.T) {
	d := newImport(io.Discard, "PRIVATE")
	for _, grant := range []uploadGrant{
		{UploadURL: "http://example.test/upload"},
		{UploadURL: "https://user:password@example.test/upload"},
		{UploadURL: "https://example.test/upload", ExpiresAt: time.Now().Add(time.Minute), UploadHeaders: map[string]string{"Authorization": "Bearer PRIVATE"}},
	} {
		if e := d.upload(context.Background(), "", packedBundle{}, grant); e == nil {
			t.Fatal("unsafe grant accepted")
		}
	}
}

func TestFinalizeRetryMarker(t *testing.T) {
	for _, tc := range []struct {
		name, body   string
		status, want int
	}{
		{"true", `{"reason":"upload-not-arrived","message":"new wording","retryable":true}`, 409, 3},
		{"true server error", `{"retryable":true}`, 503, 3},
		{"false server error", `{"retryable":false}`, 503, 1},
		{"true different status", `{"retryable":true}`, 400, 3},
		{"missing", `{"reason":"upload-not-arrived","message":"The upload has not arrived. PUT the bundle to uploadUrl, then finalize."}`, 409, 1},
		{"false", `{"reason":"upload-not-arrived","retryable":false}`, 409, 1},
		{"legacy message", `{"reason":"bundle-invalid","message":"The upload has not arrived. PUT the bundle to uploadUrl, then finalize."}`, 400, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls++
				w.WriteHeader(tc.status)
				fmt.Fprint(w, tc.body)
			}))
			defer server.Close()
			driver := newImport(io.Discard, "fixture")
			driver.base = server.URL
			driver.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
			if err := driver.finalize(context.Background(), "/session", packedBundle{}, "bundle"); err == nil {
				t.Fatal("expected refusal")
			}
			if calls != tc.want {
				t.Fatal(calls, tc.want)
			}
		})
	}
}

// Match express.json({strict:true}): JSON scalars (including null) fail
// before the route handler, while an absent body and objects/arrays pass.
func strictJSONBody(w http.ResponseWriter, r *http.Request) bool {
	if r.Header.Get("Content-Type") != "application/json" {
		return true
	}
	raw, err := io.ReadAll(r.Body)
	r.Body = io.NopCloser(bytes.NewReader(raw))
	trimmed := bytes.TrimSpace(raw)
	if err != nil || (len(trimmed) > 0 && (!json.Valid(trimmed) || (trimmed[0] != '{' && trimmed[0] != '['))) {
		w.Header().Set("Content-Type", "text/html")
		w.WriteHeader(http.StatusBadRequest)
		fmt.Fprint(w, "<!DOCTYPE html><title>Bad Request</title>")
		return false
	}
	return true
}

func TestImportRequestBodies(t *testing.T) {
	for _, tc := range []struct {
		name, method string
		body         any
	}{
		{"bodyless poll", "GET", nil},
		{"bodyless post", "POST", nil},
		{"JSON post", "POST", map[string]string{"name": "fixture"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !strictJSONBody(w, r) {
					return
				}
				calls++
				raw, _ := io.ReadAll(r.Body)
				if r.Method != tc.method || r.Header.Get("Authorization") != "Bearer fixture" {
					t.Error("request method/auth changed")
				}
				if tc.body == nil {
					if len(raw) != 0 || r.ContentLength != 0 || r.Header.Get("Content-Type") != "" {
						t.Errorf("bodyless request sent %q, length %d, type %q", raw, r.ContentLength, r.Header.Get("Content-Type"))
					}
				} else if string(raw) != `{"name":"fixture"}` || r.Header.Get("Content-Type") != "application/json" {
					t.Errorf("JSON request changed: %s", raw)
				}
				if calls == 1 {
					w.WriteHeader(503)
					return
				}
				fmt.Fprint(w, `{"status":"approved"}`)
			}))
			defer server.Close()
			d := newImport(io.Discard, "fixture")
			d.base = server.URL
			d.sleep = func(ctx context.Context, _ time.Duration) error { return ctx.Err() }
			var result importSession
			if err := d.request(context.Background(), tc.method, "/session", tc.body, &result, true); err != nil {
				t.Fatal(err)
			}
			if calls != 2 || result.Status != "approved" {
				t.Fatalf("retry/response failed: %d %+v", calls, result)
			}
		})
	}
	// Pin the fixture boundary that the original integration tests omitted.
	for _, raw := range []string{"null", "true", "42", `"scalar"`} {
		r := httptest.NewRequest("GET", "/", strings.NewReader(raw))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		if strictJSONBody(w, r) || w.Code != 400 {
			t.Errorf("strict fixture admitted %s", raw)
		}
	}
}
