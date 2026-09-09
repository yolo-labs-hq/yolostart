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
	for _, scenario := range []string{"success", "denied", "changed", "upload-failed", "seed-failed", "timeout", "ready-without-seed", "retry-create", "retry-finalize"} {
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
			success := scenario == "success" || scenario == "retry-create" || scenario == "retry-finalize"
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
			if creates > 0 && failure != "" {
				t.Fatal("client overrode pod verdict")
			}
			if scenario == "retry-create" && creates != 2 {
				t.Fatal(creates)
			}
			if scenario == "retry-finalize" && finalizes != 2 {
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
