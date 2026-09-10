package yolostart

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type approval struct {
	CandidateRelPath string   `json:"candidateRelPath"`
	WorkspaceName    string   `json:"workspaceName"`
	ExcludePaths     []string `json:"excludePaths"`
	IncludeOverflow  bool     `json:"includeOverflow"`
}
type importSession struct {
	ID          string    `json:"id"`
	Status      string    `json:"status"`
	ExpiresAt   time.Time `json:"expiresAt"`
	Approval    *approval `json:"approval"`
	WorkspaceID string    `json:"workspaceId"`
	Seed        *struct {
		Status string `json:"status"`
		Reason string `json:"reason"`
	} `json:"seed"`
	Failure *struct {
		Reason  string `json:"reason"`
		Message string `json:"message"`
	} `json:"failure"`
}
type uploadGrant struct {
	BundleID      string            `json:"bundleId"`
	UploadURL     string            `json:"uploadUrl"`
	UploadHeaders map[string]string `json:"uploadHeaders"`
	ExpiresAt     time.Time         `json:"expiresAt"`
}
type apiError struct {
	status          int
	reason, message string
	retryable       bool
}

func (e *apiError) Error() string {
	return fmt.Sprintf("import refused (HTTP %d, %s): %s", e.status, e.reason, e.message)
}

type importDriver struct {
	client, uploadClient *http.Client
	base, browser, token string
	now                  func() time.Time
	sleep                func(context.Context, time.Duration) error
	poll, waitLimit      time.Duration
	report               io.Writer
	lastProgress         time.Time
	lastProgressBody     string
}

func newImport(w io.Writer, token string) *importDriver {
	auth := newAuth(w)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DisableCompression = true
	noRedirect := func(*http.Request, []*http.Request) error { return errors.New("redirect refused") }
	return &importDriver{
		client:       &http.Client{Timeout: 2 * time.Minute, CheckRedirect: noRedirect},
		uploadClient: &http.Client{Timeout: 15 * time.Minute, Transport: transport, CheckRedirect: noRedirect},
		base:         defaultAPIURL, browser: defaultAppURL, token: token,
		now: time.Now, sleep: auth.sleep, poll: 2 * time.Second, waitLimit: 20 * time.Minute, report: w,
	}
}
func (d *importDriver) request(ctx context.Context, method, route string, body, out any, retry bool) error {
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		if err != nil {
			return err
		}
	}
	for attempt := 0; ; attempt++ {
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader(data)
		}
		req, e := http.NewRequestWithContext(ctx, method, d.base+route, reader)
		if e != nil {
			return errors.New("invalid import API request")
		}
		req.Header.Set("Authorization", "Bearer "+d.token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, e := d.client.Do(req)
		transient := e != nil
		var result error
		if e != nil {
			result = errors.New("import API connection failed")
		} else {
			raw, readErr := io.ReadAll(io.LimitReader(res.Body, (2<<20)+1))
			res.Body.Close()
			transient = res.StatusCode >= 500
			if res.StatusCode < 200 || res.StatusCode >= 300 {
				refusal := struct {
					Reason    string `json:"reason"`
					Message   string `json:"message"`
					Retryable *bool  `json:"retryable"`
				}{}
				_ = json.Unmarshal(raw, &refusal)
				if refusal.Reason != "" || refusal.Retryable != nil {
					transient = false
				}
				result = &apiError{status: res.StatusCode, reason: refusal.Reason, message: refusal.Message, retryable: refusal.Retryable != nil && *refusal.Retryable}
			} else if readErr != nil || len(raw) > 2<<20 {
				result = errors.New("invalid import API response")
				transient = true
			} else if out != nil && json.Unmarshal(raw, out) != nil {
				result = errors.New("invalid import API JSON response")
				transient = true
			} else {
				return nil
			}
		}
		if !retry || !transient || attempt >= 2 {
			return result
		}
		if e = d.sleep(ctx, time.Duration(attempt+1)*time.Second); e != nil {
			return e
		}
	}
}
func sessionPath(id string) (string, error) {
	if !safeArchivePath(id) || strings.Contains(id, "/") || strings.ContainsAny(id, "?#%") {
		return "", errors.New("invalid import session id")
	}
	return "/yolostart/sessions/" + url.PathEscape(id), nil
}
func (d *importDriver) wait(ctx context.Context, route string, seed bool) (importSession, error) {
	deadline := d.now().Add(d.waitLimit)
	for d.now().Before(deadline) {
		var s importSession
		if e := d.request(ctx, "GET", route, nil, &s, true); e != nil {
			return s, e
		}
		switch s.Status {
		case "denied", "expired", "failed":
			if s.Failure != nil {
				return s, fmt.Errorf("import %s: %s (%s)", s.Status, s.Failure.Message, s.Failure.Reason)
			}
			return s, fmt.Errorf("import %s", s.Status)
		case "awaiting-approval", "approved", "packing", "uploading", "creating", "seeding", "ready":
		default:
			return s, errors.New("unrecognized import session status")
		}
		if !s.ExpiresAt.IsZero() && !d.now().Before(s.ExpiresAt) {
			return s, errors.New("import session expired")
		}
		if seed {
			if s.Seed != nil {
				if s.Seed.Status == "failed" {
					return s, fmt.Errorf("workspace seed failed: %s", s.Seed.Reason)
				}
				if s.Seed.Status == "succeeded" && s.WorkspaceID != "" {
					return s, nil
				}
			}
		} else if s.Status == "approved" && s.Approval != nil {
			return s, nil
		} else if s.Status != "awaiting-approval" {
			return s, errors.New("session is not awaiting this client's approval")
		}
		if e := d.sleep(ctx, min(d.poll, deadline.Sub(d.now()))); e != nil {
			return s, e
		}
	}
	return importSession{}, errors.New("import polling timed out; success was not reported by the pod")
}
func (d *importDriver) progress(ctx context.Context, route string, body any) {
	raw, e := json.Marshal(body)
	if e != nil || string(raw) == d.lastProgressBody || !d.lastProgress.IsZero() && d.now().Sub(d.lastProgress) < time.Second {
		return
	}
	d.lastProgress = d.now()
	d.lastProgressBody = string(raw)
	// Progress is advisory and must not turn a transient reporting failure into data loss.
	reportCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	_ = d.request(reportCtx, "PUT", route+"/progress", body, nil, false)
}

type uploadReader struct {
	io.Reader
	done   int64
	update func(int64)
}

func (r *uploadReader) Read(p []byte) (int, error) {
	n, e := r.Reader.Read(p)
	r.done += int64(n)
	r.update(r.done)
	return n, e
}
func (d *importDriver) upload(ctx context.Context, route string, bundle packedBundle, grant uploadGrant) error {
	u, e := url.Parse(grant.UploadURL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || grant.ExpiresAt.IsZero() {
		return errors.New("invalid upload grant")
	}
	headers := http.Header{}
	for key, value := range grant.UploadHeaders {
		switch http.CanonicalHeaderKey(key) {
		case "Content-Type", "Content-Length", "X-Amz-Checksum-Sha256":
			if headers.Get(key) != "" {
				return errors.New("duplicate upload header")
			}
			headers.Set(key, value)
		default:
			return errors.New("unexpected upload header")
		}
	}
	if headers.Get("Content-Type") != "application/gzip" || headers.Get("Content-Length") != strconv.FormatInt(bundle.size, 10) || headers.Get("X-Amz-Checksum-Sha256") == "" {
		return errors.New("incomplete upload grant")
	}
	for attempt := 0; attempt < 3; attempt++ {
		if !d.now().Before(grant.ExpiresAt) {
			return errors.New("upload grant expired")
		}
		f, e := os.Open(bundle.filename)
		if e != nil {
			return e
		}
		reader := &uploadReader{Reader: f, update: func(done int64) {
			d.progress(ctx, route, map[string]any{"phase": "uploading", "bytesDone": done, "bytesTotal": bundle.size})
		}}
		req, e := http.NewRequestWithContext(ctx, "PUT", grant.UploadURL, reader)
		if e != nil {
			f.Close()
			return errors.New("invalid upload request")
		}
		req.Header = headers.Clone()
		// Empty User-Agent suppresses Go's default; Content-Length is a Request field.
		req.Header["User-Agent"] = []string{""}
		req.ContentLength = bundle.size
		res, e := d.uploadClient.Do(req)
		f.Close()
		retry := e != nil
		if e == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 4096))
			res.Body.Close()
			if res.StatusCode >= 200 && res.StatusCode < 300 {
				return nil
			}
			retry = res.StatusCode >= 500 || res.StatusCode == 429
		}
		if !retry || attempt == 2 {
			return errors.New("bundle upload failed; no workspace success was reported")
		}
		if e = d.sleep(ctx, time.Duration(attempt+1)*time.Second); e != nil {
			return e
		}
	}
	return errors.New("bundle upload failed")
}

// Retry authority comes from the server marker, never status or human wording.
func retryableRefusal(err error) bool {
	var refusal *apiError
	return errors.As(err, &refusal) && refusal.retryable
}
func (d *importDriver) finalize(ctx context.Context, route string, bundle packedBundle, id string) error {
	for attempt := 0; ; attempt++ {
		err := d.request(ctx, "POST", route+"/bundle/finalize", map[string]any{"bundleId": id, "fileList": bundle.files}, nil, true)
		if !retryableRefusal(err) || attempt == 2 {
			return err
		}
		if err = d.sleep(ctx, time.Duration(attempt+1)*time.Second); err != nil {
			return err
		}
	}
}

func (d *importDriver) execute(ctx context.Context, manifest ScanManifest, inventories map[string]inventory, out io.Writer) (result error) {
	var created importSession
	if e := d.request(ctx, "POST", "/yolostart/sessions", map[string]any{"manifest": manifest}, &created, false); e != nil {
		return e
	}
	route, e := sessionPath(created.ID)
	if e != nil {
		return e
	}
	if created.Status != "awaiting-approval" {
		return errors.New("new session is not awaiting approval")
	}
	fmt.Fprintf(d.report, "Approve import: %s/start/%s\n", d.browser, url.PathEscape(created.ID))
	approved, e := d.wait(ctx, route, false)
	if e != nil {
		return e
	}
	reason := "aborted"
	serverOwnsVerdict := false
	defer func() {
		if result == nil || serverOwnsVerdict {
			return
		}
		if ctx.Err() != nil {
			reason = "aborted"
		}
		failureCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		// The server rejects this once workspace creation has won the race.
		_ = d.request(failureCtx, "POST", route+"/fail", map[string]string{"reason": reason, "message": failureMessage(reason)}, nil, false)
	}()
	inv, ok := inventories[approved.Approval.CandidateRelPath]
	if !ok || strings.TrimSpace(approved.Approval.WorkspaceName) == "" {
		return errors.New("approval did not identify a scanned candidate and workspace name")
	}
	dir, e := os.MkdirTemp("", "yolostart-pack-")
	if e != nil {
		return e
	}
	defer os.RemoveAll(dir)
	reason = "pack-failed"
	bundle, e := pack(ctx, inv, approved.Approval.ExcludePaths, approved.Approval.IncludeOverflow, dir, func(done, total int) {
		d.progress(ctx, route, map[string]any{"phase": "packing", "filesDone": done, "filesTotal": total})
	})
	if e != nil {
		if errors.Is(e, errFilesChanged) {
			reason = "files-changed"
		}
		if ctx.Err() != nil {
			reason = "aborted"
		}
		return e
	}
	reason = "upload-failed"
	var grant uploadGrant
	if e = d.request(ctx, "POST", route+"/bundle", map[string]any{"bytes": bundle.size, "sha256": bundle.digest}, &grant, false); e != nil {
		return e
	}
	if grant.BundleID == "" {
		return errors.New("upload grant lacks bundle id")
	}
	if e = d.upload(ctx, route, bundle, grant); e != nil {
		if ctx.Err() != nil {
			reason = "aborted"
		}
		return e
	}
	if e = d.finalize(ctx, route, bundle, grant.BundleID); e != nil {
		var refusal *apiError
		if errors.As(e, &refusal) && refusal.status >= 400 && refusal.status < 500 && !retryableRefusal(e) {
			serverOwnsVerdict = true // Server owns the terminal refusal; do not overwrite it with /fail.
		}
		return e
	}
	reason = "aborted"
	if e = d.request(ctx, "POST", "/workspaces", map[string]string{"name": approved.Approval.WorkspaceName, "importBundleId": grant.BundleID}, nil, true); e != nil {
		return e
	}
	// Creation was acknowledged; the pod exclusively owns the verdict from here.
	serverOwnsVerdict = true
	seeded, e := d.wait(ctx, route, true)
	if e != nil {
		return e
	}
	fmt.Fprintf(out, "%s/workspace?id=%s\n", d.browser, url.QueryEscape(seeded.WorkspaceID))
	return nil
}
func failureMessage(reason string) string {
	switch reason {
	case "files-changed":
		return "Files changed after scanning. Re-run yolostart for fresh approval."
	case "pack-failed":
		return "Your machine could not safely pack the approved files. Check the CLI error and re-run."
	case "upload-failed":
		return "Your machine could not finish sending the approved bundle. Check the CLI error and re-run."
	default:
		return "Your machine stopped the import before workspace creation was confirmed."
	}
}
