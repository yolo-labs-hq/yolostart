package yolostart

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
)

func TestHistoryCeilingAndSchema(t *testing.T) {
	root := t.TempDir()
	put(t, root, ".git/objects/pack/history.pack", "")
	put(t, root, "source.txt", "source")
	for _, size := range []int64{HistoryLimit, HistoryLimit + 1} {
		if e := os.Truncate(filepath.Join(root, ".git/objects/pack/history.pack"), size); e != nil {
			t.Fatal(e)
		}
		m, files, e := BuildManifest(root, root, true)
		if e != nil {
			t.Fatal(e)
		}
		included := size <= HistoryLimit
		if m.Git.HistoryBytes != size || m.Git.HistoryIncluded != included || slices.Contains(files, ".git/objects/pack/history.pack") != included {
			t.Fatalf("%+v %v", m.Git, files)
		}
		if !included && !slices.Contains(m.Excluded.Skipped, ".git") {
			t.Fatal("omission not reported")
		}
		data, _ := json.Marshal(m.Git)
		if !bytes.Contains(data, []byte(`"historyBytes":`)) || !bytes.Contains(data, []byte(`"historyIncluded":`)) {
			t.Fatal(string(data))
		}
	}
	external := t.TempDir()
	put(t, external, "huge", "")
	if e := os.Truncate(filepath.Join(external, "huge"), HistoryLimit*2); e != nil {
		t.Fatal(e)
	}
	if e := os.Symlink(external, filepath.Join(root, ".git/external")); e != nil {
		t.Fatal(e)
	}
	size, _, e := historySize(root)
	if e != nil || size != HistoryLimit+1 {
		t.Fatal(size, e)
	}
}
func TestWorktreeHistoryUnavailable(t *testing.T) {
	root := t.TempDir()
	put(t, root, ".git", "gitdir: /external/private")
	m, files, e := BuildManifest(root, root, true)
	if e != nil || m.Git.HistoryIncluded || m.Git.HistoryBytes != 0 || slices.Contains(files, ".git") {
		t.Fatal(m, e)
	}
}
func unpackTest(t *testing.T, filename string) map[string]string {
	t.Helper()
	f, e := os.Open(filename)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	gz, e := gzip.NewReader(f)
	if e != nil {
		t.Fatal(e)
	}
	defer gz.Close()
	reader := tar.NewReader(gz)
	out := map[string]string{}
	for {
		h, e := reader.Next()
		if e == io.EOF {
			break
		}
		if e != nil {
			t.Fatal(e)
		}
		if h.Typeflag == tar.TypeDir {
			continue
		}
		if h.Typeflag != tar.TypeReg {
			t.Fatal("nonregular entry", h)
		}
		b, e := io.ReadAll(reader)
		if e != nil {
			t.Fatal(e)
		}
		out[h.Name] = string(b)
	}
	return out
}
func TestPackOnlyApprovedSnapshotAndSanitizeConfig(t *testing.T) {
	root := repo(t, t.TempDir(), "project", "")
	original := "[core]\nrepositoryformatversion=0\n[remote \"origin\"]\nurl=https://user:SECRET@github.com/org/repo?token=SECRET\nfetch=+refs/heads/*:refs/remotes/origin/*\n[branch \"main\"]\nremote=origin\nmerge=refs/heads/main\n[credential]\nhelper=!echo SECRET\n[http]\nextraheader=Authorization: SECRET\n[include]\npath=/secret/config\n"
	put(t, root, ".git/config", original)
	put(t, root, "src/omit.txt", "omit")
	put(t, root, "src2/keep.txt", "keep")
	put(t, root, ".env", "SECRET")
	put(t, root, "account.json", `{"private_key":"SECRET"}`)
	inv, e := capture(context.Background(), root, root, true)
	if e != nil {
		t.Fatal(e)
	}
	put(t, root, "new-after-scan.txt", "not approved")
	b, e := pack(context.Background(), inv, []string{"src/omit.txt"}, false, t.TempDir(), nil)
	if e != nil {
		t.Fatal(e)
	}
	files := unpackTest(t, b.filename)
	if files["src2/keep.txt"] != "keep" || files["src/omit.txt"] != "" || files[".env"] != "" || files["account.json"] != "" || files["new-after-scan.txt"] != "" {
		t.Fatal(files)
	}
	for name := range files {
		if strings.HasPrefix(name, ".git/hooks/") {
			t.Fatal("hook shipped", name)
		}
	}
	if !slices.Contains(inv.manifest.Excluded.Skipped, ".git/hooks") {
		t.Fatal("hooks not reported excluded")
	}
	config := files[".git/config"]
	if !strings.Contains(config, "https://github.com/org/repo") || strings.Contains(config, "SECRET") || strings.Contains(config, "helper") || strings.Contains(config, "extraheader") || strings.Contains(config, "include") {
		t.Fatal(config)
	}
	data, e := os.ReadFile(filepath.Join(root, ".git/config"))
	if e != nil || string(data) != original {
		t.Fatal("local config changed", e)
	}
	if !excludedPath("src/a", []string{"src"}) || excludedPath("src2/a", []string{"src"}) {
		t.Fatal("prefix boundaries")
	}
	for _, bad := range []string{"../src", "/src", "src\\file", "[remaining paths]", "missing"} {
		if _, e := pack(context.Background(), inv, []string{bad}, false, t.TempDir(), nil); e == nil {
			t.Fatal("invalid prefix", bad)
		}
	}
}
func TestPackRefusesChangesSecretsAndSymlinks(t *testing.T) {
	for _, kind := range []string{"changed", "secret", "symlink", "parent-symlink", "deleted"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			put(t, root, "sub/data.json", `{"name":"safe"}`)
			inv, e := capture(context.Background(), root, root, false)
			if e != nil {
				t.Fatal(e)
			}
			filename := filepath.Join(root, "sub/data.json")
			switch kind {
			case "changed":
				put(t, root, "sub/data.json", `{"name":"edit"}`)
			case "secret":
				put(t, root, "sub/data.json", `{"private_key":"SECRET"}`)
			case "symlink":
				os.Remove(filename)
				os.Symlink("/etc/passwd", filename)
			case "parent-symlink":
				os.RemoveAll(filepath.Join(root, "sub"))
				os.Symlink("/etc", filepath.Join(root, "sub"))
			case "deleted":
				os.Remove(filename)
			}
			if _, e := pack(context.Background(), inv, nil, false, t.TempDir(), nil); !errors.Is(e, errFilesChanged) {
				t.Fatal(e)
			}
		})
	}
}
func TestCompressedLimit(t *testing.T) {
	var target bytes.Buffer
	writer := cappedWriter{w: &target, n: BundleLimit - 1}
	if _, e := writer.Write([]byte("xx")); e == nil || target.Len() != 0 {
		t.Fatal("limit bypassed")
	}
}

func TestOverflowRequiresExplicitApproval(t *testing.T) {
	root := t.TempDir()
	for i := 0; i < 205; i++ {
		put(t, root, fmt.Sprintf("%03d.txt", i), "ok")
	}
	inv, e := capture(context.Background(), root, root, false)
	if e != nil {
		t.Fatal(e)
	}
	for _, include := range []bool{false, true} {
		b, e := pack(context.Background(), inv, nil, include, t.TempDir(), nil)
		if e != nil {
			t.Fatal(e)
		}
		want := 199
		if include {
			want = 205
		}
		if len(b.files) != want {
			t.Fatal(include, len(b.files))
		}
	}
}

func TestPortableConfigMatchesServerAllowlist(t *testing.T) {
	data, err := sanitizedConfig(context.Background(), []byte("[remote \"origin\"]\nurl=https://user:TOKEN@host/repo\npushurl=https://host/push\n[core]\nprecomposeunicode=true\nlogallrefupdates=true\n"), t.TempDir())
	if err != nil || bytes.Contains(data, []byte("pushurl")) || bytes.Contains(data, []byte("TOKEN")) || !bytes.Contains(data, []byte("precomposeunicode = true")) {
		t.Fatal(string(data), err)
	}
	for _, config := range []string{
		"[extensions]\nobjectformat=sha256\n",
		"[extensions]\nworktreeconfig=true\n",
		"[remote \"origin\"]\nurl=https://host/" + strings.Repeat("x", 2048) + "\n",
	} {
		if _, err := sanitizedConfig(context.Background(), []byte(config), t.TempDir()); err == nil {
			t.Fatal("unsupported config accepted")
		}
	}
}

func TestPackedConfigPreservesSSHAccountWithoutPassword(t *testing.T) {
	data, e := sanitizedConfig(context.Background(), []byte("[remote \"origin\"]\nurl=ssh://git:password@github.com/org/repo.git\n"), t.TempDir())
	if e != nil || !strings.Contains(string(data), "ssh://git@github.com/org/repo.git") || strings.Contains(string(data), "password") {
		t.Fatal(string(data), e)
	}
}

func TestRepositoryStructureRoundTrip(t *testing.T) {
	for _, state := range []string{"unborn-unstaged", "unborn-staged", "packed-refs"} {
		t.Run(state, func(t *testing.T) {
			root := repo(t, t.TempDir(), "unborn", "")
			put(t, root, "source.txt", "uncommitted source")
			stamp := time.Unix(1700000000, 123456789)
			if err := os.Chtimes(filepath.Join(root, "source.txt"), stamp, stamp); err != nil {
				t.Fatal(err)
			}
			gitCmd := func(dir string, args ...string) string {
				t.Helper()
				out, err := exec.Command("git", append([]string{"-C", dir}, args...)...).CombinedOutput()
				if err != nil {
					t.Fatalf("git %v: %v %s", args, err, out)
				}
				return string(out)
			}
			if state != "unborn-unstaged" {
				gitCmd(root, "add", "source.txt")
			}
			var head string
			if state == "packed-refs" {
				gitCmd(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "-c", "commit.gpgsign=false", "commit", "-m", "fixture")
				gitCmd(root, "pack-refs", "--all", "--prune")
				head = gitCmd(root, "rev-parse", "HEAD")
			}
			before := gitCmd(root, "status", "--porcelain=v1")
			inv, err := capture(context.Background(), root, root, true)
			if err != nil {
				t.Fatal(err)
			}
			bundle, err := pack(context.Background(), inv, nil, false, t.TempDir(), nil)
			if err != nil {
				t.Fatal(err)
			}
			dest := t.TempDir()
			if out, err := exec.Command("tar", "-xzf", bundle.filename, "-C", dest).CombinedOutput(); err != nil {
				t.Fatalf("extract: %v %s", err, out)
			}
			if got := gitCmd(dest, "rev-parse", "--is-inside-work-tree"); got != "true\n" {
				t.Fatal(got)
			}
			if got := gitCmd(dest, "status", "--porcelain=v1"); got != before {
				t.Fatalf("index/worktree changed: %q != %q", got, before)
			}
			gitCmd(dest, "fsck", "--full")
			if head != "" {
				if got := gitCmd(dest, "rev-parse", "HEAD"); got != head {
					t.Fatal("commit changed", got, head)
				}
			} else if err := exec.Command("git", "-C", dest, "rev-parse", "--verify", "HEAD").Run(); err == nil {
				t.Fatal("import fabricated a commit")
			}
			for _, name := range []string{"objects", "refs/heads", "refs/tags", "logs"} {
				info, err := os.Stat(filepath.Join(dest, ".git", name))
				if err != nil || !info.IsDir() {
					t.Fatalf("missing git directory %s: %v", name, err)
				}
			}
			info, err := os.Stat(filepath.Join(dest, "source.txt"))
			if err != nil || !info.ModTime().Equal(stamp) {
				t.Fatalf("mtime lost: %v %v", info, err)
			}
		})
	}
}
