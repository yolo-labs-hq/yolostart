package yolostart

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
)

func TestGitUnbornManifest(t *testing.T) {
	for _, state := range []string{"unborn", "staged", "committed", "detached"} {
		t.Run(state, func(t *testing.T) {
			date := ""
			want := state == "unborn" || state == "staged"
			if !want {
				date = "2026-09-10T00:00:00Z"
			}
			root := repo(t, t.TempDir(), "project", date)
			if state == "staged" {
				put(t, root, "source.txt", "local work")
				if out, err := exec.Command("git", "-C", root, "add", "source.txt").CombinedOutput(); err != nil {
					t.Fatalf("%s: %v", out, err)
				}
			}
			if state == "detached" {
				if out, err := exec.Command("git", "-C", root, "checkout", "--detach").CombinedOutput(); err != nil {
					t.Fatalf("%s: %v", out, err)
				}
			}
			manifest, _, err := BuildManifest(root, root, true)
			if err != nil {
				t.Fatal(err)
			}
			if manifest.Git == nil || manifest.Git.Unborn != want {
				t.Fatalf("git=%+v want unborn=%v", manifest.Git, want)
			}
			raw, err := json.Marshal(manifest.Git)
			if err != nil {
				t.Fatal(err)
			}
			var fields map[string]any
			if err := json.Unmarshal(raw, &fields); err != nil {
				t.Fatal(err)
			}
			if v, ok := fields["unborn"]; !ok || v != want {
				t.Fatalf("explicit boolean missing/wrong: %s", raw)
			}
			if want && (manifest.Git.LastCommitAt != nil || manifest.Git.Branch == nil) {
				t.Fatal("legacy inference fields changed", manifest.Git)
			}
		})
	}
}

func TestUnbornWarningUsesOnlyChosenRepo(t *testing.T) {
	for _, scenario := range []string{"single", "selected-unborn", "selected-committed", "picker", "plain"} {
		t.Run(scenario, func(t *testing.T) {
			root := t.TempDir()
			args := []string{"--no-browser", "--dry-run", "--scan", root}
			if scenario != "plain" {
				repo(t, root, "unborn-project", "")
				if scenario != "single" {
					repo(t, root, "committed-project", "2026-09-10T00:00:00Z")
				}
			}
			if scenario == "selected-unborn" {
				args = append(args, "--project", "unborn-project")
			}
			if scenario == "selected-committed" {
				args = append(args, "--project", "committed-project")
			}
			var out, report bytes.Buffer
			err := run(context.Background(), args, &out, &report, func(context.Context) (string, error) { return "fixture", nil })
			if err != nil {
				t.Fatal(err)
			}
			var manifest ScanManifest
			if err := json.Unmarshal(out.Bytes(), &manifest); err != nil {
				t.Fatalf("warning polluted JSON: %v", err)
			}
			want := scenario == "single" || scenario == "selected-unborn"
			if got := strings.Count(report.String(), "has no commits yet"); got != map[bool]int{false: 0, true: 1}[want] {
				t.Fatalf("unexpected warning: %s", report.String())
			}
			if want && (!strings.Contains(report.String(), "unborn-project") || !strings.Contains(report.String(), "git commit in this local project")) {
				t.Fatal(report.String())
			}
			if scenario == "plain" && manifest.Candidates[0].Git != nil {
				t.Fatal("plain directory got git metadata")
			}
		})
	}
}

func TestUnbornWarningBeforeSessionCreation(t *testing.T) {
	root := repo(t, t.TempDir(), "local-project", "")
	var report bytes.Buffer
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Method != "POST" || r.URL.Path != "/v1/yolostart/sessions" {
			t.Error("unexpected request", r.Method, r.URL.Path)
		}
		if !strings.Contains(report.String(), `"local-project" has no commits yet`) {
			t.Error("warning was not printed before session creation")
		}
		var body struct {
			Manifest ScanManifest `json:"manifest"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		} else if len(body.Manifest.Candidates) != 1 || !body.Manifest.Candidates[0].Git.Unborn {
			t.Error("session missing unborn metadata")
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(403)
		io.WriteString(w, `{"reason":"fixture-stop","message":"fixture stops before upload","retryable":false}`)
	}))
	defer server.Close()
	t.Setenv("YOLOSTART_API_URL", server.URL+"/v1")
	err := run(context.Background(), []string{"--no-browser", "--scan", root}, io.Discard, &report, func(context.Context) (string, error) { return "fixture", nil })
	if err == nil || calls != 1 {
		t.Fatal(err, calls)
	}
	if _, err := exec.Command("git", "-C", root, "rev-parse", "--verify", "HEAD").Output(); err == nil {
		t.Fatal("warning created a commit")
	}
}
