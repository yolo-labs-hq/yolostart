package yolostart

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func put(t *testing.T, root, name, contents string) {
	t.Helper()
	p := filepath.Join(root, name)
	if e := os.MkdirAll(filepath.Dir(p), 0755); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(p, []byte(contents), 0644); e != nil {
		t.Fatal(e)
	}
}
func repo(t *testing.T, root, name, date string) string {
	t.Helper()
	p := filepath.Join(root, name)
	if e := os.MkdirAll(p, 0755); e != nil {
		t.Fatal(e)
	}
	cmd := exec.Command("git", "init", "-q", "-b", "main", p)
	if b, e := cmd.CombinedOutput(); e != nil {
		t.Fatalf("%s: %v", b, e)
	}
	if date != "" {
		cmd = exec.Command("git", "-C", p, "-c", "user.name=Fixture", "-c", "user.email=test@example.test", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "fixture")
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_DATE="+date, "GIT_COMMITTER_DATE="+date)
		if b, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("%s: %v", b, e)
		}
	}
	return p
}
func TestLadderRootAndAncestor(t *testing.T) {
	base := t.TempDir()
	root := repo(t, base, "primary", "")
	repo(t, root, "nested", "")
	put(t, root, "src/main.txt", "hi")
	for _, start := range []string{root, filepath.Join(root, "src")} {
		r, e := Resolve(start)
		if e != nil || r.Mode != "single" || len(r.Candidates) != 1 || r.Candidates[0].Root != root {
			t.Fatalf("%+v %v", r, e)
		}
	}
}
func TestLadderDiscoveryDepthIgnoreAndSymlink(t *testing.T) {
	base := t.TempDir()
	root := repo(t, base, "group/primary", "")
	repo(t, base, "a/b/too-deep", "")
	repo(t, base, "node_modules/dependency", "")
	repo(t, base, "ignored", "")
	put(t, base, ".gitignore", "ignored/\n")
	if e := os.Symlink(root, filepath.Join(base, "linked")); e != nil {
		t.Fatal(e)
	}
	r, e := Resolve(base)
	if e != nil || r.Mode != "single" || len(r.Candidates) != 1 || r.Candidates[0].Root != root {
		t.Fatalf("%+v %v", r, e)
	}
}
func TestLadderRanksAllCandidatesWithoutChoosing(t *testing.T) {
	base := t.TempDir()
	old := repo(t, base, "old", "2025-01-01T00:00:00Z")
	newer := repo(t, base, "newer", "2026-01-01T00:00:00Z")
	newest := repo(t, base, "newest", "2026-01-01T00:00:00Z")
	for i, p := range []string{newer, newest, old} {
		d := time.Unix(int64(i+1)*100, 0)
		if e := os.Chtimes(p, d, d); e != nil {
			t.Fatal(e)
		}
	}
	r, e := Resolve(base)
	if e != nil {
		t.Fatal(e)
	}
	c, e := Select(r, "")
	if e != nil || c != nil {
		t.Fatal("implicit choice", c, e)
	}
	out, e := Scan(base, "")
	if e != nil {
		t.Fatal(e)
	}
	names := []string{}
	for _, c := range out.Candidates {
		names = append(names, c.Name)
	}
	if out.Mode != "picker" || !slices.Equal(names, []string{"newest", "newer", "old"}) {
		t.Fatalf("%+v", out)
	}
}
func TestLadderPlainAndExplicitProject(t *testing.T) {
	base := t.TempDir()
	put(t, base, "hello.txt", "hi")
	out, e := Scan(base, "")
	if e != nil || out.Mode != "plain" || len(out.Candidates) != 1 || out.Candidates[0].Kind != "adopt-dir" || out.Candidates[0].Git != nil {
		t.Fatalf("%+v %v", out, e)
	}
	repo(t, base, "a/same", "")
	repo(t, base, "b/same", "")
	put(t, base, "b/same/private-loser.txt", "private")
	r, e := Resolve(base)
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range []string{"same", "missing"} {
		if _, e := Select(r, name); e == nil {
			t.Fatal("ambiguous selection accepted")
		}
	}
	out, e = Scan(base, "a/same")
	b, _ := json.Marshal(out)
	if e != nil || len(out.Candidates) != 1 || !slices.Equal(out.OtherRepos, []string{"same"}) || strings.Contains(string(b), "private-loser") {
		t.Fatalf("%s %v", b, e)
	}
}
func TestWorktreePointerIsNotFollowed(t *testing.T) {
	base := t.TempDir()
	root := repo(t, base, "repo", "2026-01-01T00:00:00Z")
	lane := filepath.Join(base, "lane")
	if b, e := exec.Command("git", "-C", root, "worktree", "add", "-q", "-b", "lane", lane).CombinedOutput(); e != nil {
		t.Fatalf("%s %v", b, e)
	}
	out, e := Scan(lane, "")
	if e != nil {
		t.Fatal(e)
	}
	if *out.Candidates[0].Git.Branch != "lane" || !slices.Contains(out.Candidates[0].Excluded.Skipped, ".git") {
		t.Fatalf("%+v", out)
	}
}
func TestSecretExclusionsBeforeIgnore(t *testing.T) {
	root := t.TempDir()
	names := []string{".env", ".env.local", ".env.example", "cert.pem", "id_rsa", "id_rsa.pub", "server.key", "credentials.json", ".npmrc", ".netrc", "service-account.json", "service_account_key.json", "serviceAccount.json"}
	for _, name := range names {
		put(t, root, "nested/"+name, "NEVER SERIALIZE")
		if !sensitivePath("nested/" + name) {
			t.Fatal(name)
		}
	}
	put(t, root, ".aws/config", "secret")
	put(t, root, ".ssh/config", "secret")
	put(t, root, ".gitignore", "nested/\n")
	put(t, root, "source.ts", "export {};")
	m, includes, e := BuildManifest(root, root, false)
	if e != nil {
		t.Fatal(e)
	}
	for _, name := range names {
		if !slices.Contains(m.Excluded.Sensitive, "nested/"+name) {
			t.Fatal(name)
		}
	}
	if !slices.Equal(includes, []string{".gitignore", "source.ts"}) || !slices.Contains(m.Excluded.Sensitive, ".aws") || !slices.Contains(m.Excluded.Sensitive, ".ssh") {
		t.Fatalf("%+v %v", m, includes)
	}
}
func TestServiceAccountJSONNamesEscapesAndMalformed(t *testing.T) {
	root := t.TempDir()
	for name, body := range map[string]string{"download.json": `{"type":"service_account","private_key":"SECRET"}`, "escaped.json": `{"\u0074ype":"service\u005faccount"}`, "ignored/broken.json": `{"private_key":"SECRET",`, "array.json": `[{"client_secret":"SECRET"}]`} {
		put(t, root, name, body)
	}
	put(t, root, ".gitignore", "ignored/\n")
	put(t, root, "normal.json", `{"name":"app"}`)
	m, includes, e := BuildManifest(root, root, false)
	if e != nil || len(m.Excluded.Sensitive) != 4 || !slices.Equal(includes, []string{".gitignore", "normal.json"}) {
		t.Fatalf("%+v %v %v", m, includes, e)
	}
	data, _ := json.Marshal(m)
	if bytes.Contains(data, []byte("SECRET")) {
		t.Fatal("contents disclosed")
	}
}
func TestNestedIgnoreNegationsAndSkippedSubtrees(t *testing.T) {
	root := t.TempDir()
	for name, body := range map[string]string{".gitignore": "*.log\nignored/\n", "src/.gitignore": "!keep.log\n", "src/drop.log": "x", "src/keep.log": "x", "ignored/.gitignore": "!keep.txt\n", "ignored/keep.txt": "x", "node_modules/pkg/index.js": "x", "dist/app.js": "x", "source.txt": "x"} {
		put(t, root, name, body)
	}
	if e := os.Symlink("/etc/passwd", filepath.Join(root, "external")); e != nil {
		t.Fatal(e)
	}
	repo(t, root, "nested-repo", "")
	m, includes, e := BuildManifest(root, root, false)
	if e != nil || m.Excluded.Gitignored != 3 || !slices.Contains(includes, "src/keep.log") || slices.Contains(includes, "src/drop.log") || slices.Contains(includes, "ignored/keep.txt") || !slices.Equal(m.Excluded.Skipped, []string{"dist", "external", "nested-repo", "node_modules"}) {
		t.Fatalf("%+v %v %v", m, includes, e)
	}
}
func TestOversizeAndTreeCaps(t *testing.T) {
	root := t.TempDir()
	put(t, root, "large.bin", "")
	if e := os.Truncate(filepath.Join(root, "large.bin"), 25<<20+1); e != nil {
		t.Fatal(e)
	}
	for i := 0; i < 205; i++ {
		put(t, root, fmt.Sprintf("folder%d/deep/file.txt", i), "1234")
	}
	m, includes, e := BuildManifest(root, root, false)
	if e != nil || len(includes) != 205 || m.Bytes != 820 || len(m.Tree) != 200 || !slices.Equal(m.Excluded.Oversize, []string{"large.bin"}) {
		t.Fatalf("%+v %v", m, e)
	}
	count := 0
	var size int64
	for _, entry := range m.Tree {
		count += entry.FileCount
		size += entry.Bytes
		if len(strings.Split(entry.Path, "/")) > 2 {
			t.Fatal(entry)
		}
	}
	if count != 205 || size != 820 {
		t.Fatal(count, size)
	}
}
func TestRemoteSanitization(t *testing.T) {
	for input, want := range map[string]string{"https://user:SECRET@github.com/owner/repo.git?token=SECRET#SECRET": "https://github.com/owner/repo.git", "git@github.com:owner/repo.git": "git@github.com:owner/repo.git", "/private/local/repo": ""} {
		got := safeRemote(input)
		if got == nil && want != "" || got != nil && *got != want {
			t.Fatal(input, got)
		}
	}
}
func TestDryRunHasOnlyAuthAndNoInput(t *testing.T) {
	root := t.TempDir()
	put(t, root, "hello.txt", "hi")
	calls := 0
	login := func(context.Context) (string, error) { calls++; return "PRIVATE-TOKEN", nil }
	var out, errOut bytes.Buffer
	if e := run(context.Background(), []string{"--dry-run", "--scan", root}, &out, &errOut, login); e != nil {
		t.Fatal(e)
	}
	var m ScanManifest
	if e := json.Unmarshal(out.Bytes(), &m); e != nil {
		t.Fatal(e)
	}
	if calls != 1 || m.Mode != "plain" || strings.Contains(out.String()+errOut.String(), "PRIVATE-TOKEN") {
		t.Fatal(out.String())
	}
	for _, args := range [][]string{{"--help"}, {"--version"}, {}} {
		calls = 0
		_ = run(context.Background(), args, &out, &errOut, login)
		if calls != 0 {
			t.Fatal("auth before help/version/unavailable")
		}
	}
}
