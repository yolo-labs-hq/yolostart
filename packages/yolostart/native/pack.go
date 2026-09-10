package yolostart

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

const BundleLimit int64 = 100 << 20
const ExpandedLimit int64 = 1 << 30

var errFilesChanged = errors.New("files changed after scanning; re-run for fresh browser approval")

type fingerprint struct {
	sum   [32]byte
	mode  os.FileMode
	mtime int64
}
type inventory struct {
	root     string
	manifest Manifest
	files    map[string]fingerprint
	paths    []string
}

// OpenRoot keeps reads beneath the captured directory even if a parent is replaced.
// Lstat also rejects links within the root rather than following them.
func readLocal(root *os.Root, name string) ([]byte, os.FileInfo, error) {
	if !safeArchivePath(name) {
		return nil, nil, errFilesChanged
	}
	parts := strings.Split(name, "/")
	for i := range parts {
		st, e := root.Lstat(strings.Join(parts[:i+1], "/"))
		if e != nil || st.Mode()&os.ModeSymlink != 0 {
			return nil, nil, errFilesChanged
		}
	}
	f, e := root.OpenFile(name, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if e != nil {
		return nil, nil, errFilesChanged
	}
	defer f.Close()
	st, e := f.Stat()
	if e != nil || !st.Mode().IsRegular() || st.Size() > 25<<20 {
		return nil, nil, errFilesChanged
	}
	data, e := io.ReadAll(io.LimitReader(f, (25<<20)+1))
	if e != nil || len(data) > 25<<20 {
		return nil, nil, errFilesChanged
	}
	if sensitivePath(name) || (strings.HasSuffix(strings.ToLower(name), ".json") && sensitiveJSON(data)) {
		return nil, nil, errFilesChanged
	}
	return data, st, nil
}
func safeArchivePath(p string) bool {
	if p == "" || p == "." || p == "[remaining paths]" || path.IsAbs(p) || strings.ContainsAny(p, "\\\x00\r\n") || path.Clean(p) != p {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if part == ".." {
			return false
		}
	}
	return true
}
func excludedPath(name string, prefixes []string) bool {
	for _, prefix := range prefixes {
		if name == prefix || strings.HasPrefix(name, prefix+"/") {
			return true
		}
	}
	return false
}
func capture(ctx context.Context, root, scanRoot string, repo bool) (inventory, error) {
	m, paths, e := BuildManifest(root, scanRoot, repo)
	inv := inventory{root: root, manifest: m, paths: paths, files: map[string]fingerprint{}}
	if e != nil {
		return inv, e
	}
	handle, e := os.OpenRoot(root)
	if e != nil {
		return inv, e
	}
	defer handle.Close()
	for _, p := range paths {
		if e = ctx.Err(); e != nil {
			return inv, e
		}
		data, info, e := readLocal(handle, p)
		if e != nil {
			return inv, e
		}
		inv.files[p] = fingerprint{sha256.Sum256(data), info.Mode(), info.ModTime().UnixNano()}
	}
	return inv, nil
}
func scanImport(ctx context.Context, start, project string) (ScanManifest, map[string]inventory, error) {
	r, e := Resolve(start)
	if e != nil {
		return ScanManifest{}, nil, e
	}
	selected, e := Select(r, project)
	if e != nil {
		return ScanManifest{}, nil, e
	}
	out := ScanManifest{Mode: r.Mode, Candidates: []Manifest{}, OtherRepos: []string{}}
	candidates := r.Candidates
	if selected != nil {
		out.Mode = "single"
		candidates = []Candidate{*selected}
		for _, c := range r.Candidates {
			if c.Root != selected.Root {
				out.OtherRepos = append(out.OtherRepos, c.Name)
			}
		}
	}
	if r.Mode == "plain" {
		candidates = []Candidate{{Root: r.Root}}
	}
	inventories := map[string]inventory{}
	for _, c := range candidates {
		inv, e := capture(ctx, c.Root, r.Root, r.Mode != "plain")
		if e != nil {
			return out, nil, e
		}
		out.Candidates = append(out.Candidates, inv.manifest)
		inventories[inv.manifest.RelPath] = inv
	}
	return out, inventories, nil
}

// Rebuild portable config from a small allowlist. No credential helpers, includes,
// HTTP headers, hooks, filters or local command settings cross the trust boundary.
// Git parses the original syntax from a temporary copy; the local repo is untouched.
func sanitizedConfig(ctx context.Context, data []byte, dir string) ([]byte, error) {
	filename := filepath.Join(dir, "config-source")
	if e := os.WriteFile(filename, data, 0600); e != nil {
		return nil, e
	}
	defer os.Remove(filename)
	cmd := exec.CommandContext(ctx, "git", "config", "--file", filename, "--no-includes", "--null", "--list")
	output, e := cmd.Output()
	if e != nil {
		return nil, errors.New("cannot parse .git/config safely")
	}
	var out bytes.Buffer
	fmt.Fprintln(&out, "[core]\n\trepositoryformatversion = 0\n\tbare = false")
	for _, record := range bytes.Split(output, []byte{0}) {
		if len(record) == 0 {
			continue
		}
		key, value, _ := strings.Cut(string(record), "\n")
		first := strings.IndexByte(key, '.')
		last := strings.LastIndexByte(key, '.')
		if first < 0 {
			continue
		}
		section, field := strings.ToLower(key[:first]), strings.ToLower(key[last+1:])
		if section == "extensions" {
			return nil, errors.New("Git repository extensions are not supported by import; history cannot be safely rewritten")
		}
		if first == last {
			if section == "core" && (field == "repositoryformatversion" || field == "filemode" || field == "ignorecase" || field == "logallrefupdates" || field == "precomposeunicode") {
				if value != "0" && value != "1" && value != "true" && value != "false" {
					return nil, errors.New("unsupported portable Git configuration")
				}
				fmt.Fprintf(&out, "[%s]\n\t%s = %s\n", section, field, value)
			}
			continue
		}
		subsection := key[first+1 : last]
		if len(strconv.Quote(subsection))-2 > 255 || strings.ContainsAny(subsection, "\x00\r\n") {
			return nil, errors.New("invalid Git subsection")
		}
		if section == "remote" && field == "url" {
			clean := safeRemote(value)
			if clean == nil {
				continue
			}
			if len(strconv.Quote(*clean)) > 2048 {
				return nil, errors.New("Git remote URL exceeds import limit")
			}
			fmt.Fprintf(&out, "[remote %s]\n\t%s = %s\n", strconv.Quote(subsection), field, strconv.Quote(*clean))
		} else if section == "remote" && field == "fetch" || section == "branch" && (field == "remote" || field == "merge") {
			if len(strconv.Quote(value)) > 2048 || strings.ContainsAny(value, "\x00\r\n") {
				return nil, errors.New("invalid Git tracking configuration")
			}
			fmt.Fprintf(&out, "[%s %s]\n\t%s = %s\n", section, strconv.Quote(subsection), field, strconv.Quote(value))
		}
	}
	if out.Len() > 64<<10 {
		return nil, errors.New("portable Git config exceeds 64 KiB")
	}
	return out.Bytes(), nil
}

type packedBundle struct {
	filename, digest string
	size             int64
	files            []string
}
type cappedWriter struct {
	w io.Writer
	n int64
}

func (w *cappedWriter) Write(p []byte) (int, error) {
	if w.n+int64(len(p)) > BundleLimit {
		return 0, errors.New("compressed bundle exceeds 100 MiB; narrow the import")
	}
	n, e := w.w.Write(p)
	w.n += int64(n)
	return n, e
}
func pack(ctx context.Context, inv inventory, prefixes []string, includeOverflow bool, dir string, progress func(int, int)) (packedBundle, error) {
	result := packedBundle{filename: filepath.Join(dir, "bundle.tar.gz"), files: []string{}}
	for _, prefix := range prefixes {
		valid := false
		for _, row := range inv.manifest.Tree {
			if row.Path == prefix {
				valid = true
				break
			}
		}
		if !valid || !safeArchivePath(prefix) {
			return result, errors.New("invalid browser exclusion prefix")
		}
	}
	allowed := func(p string) bool {
		if p == ".git/hooks" || strings.HasPrefix(p, ".git/hooks/") || excludedPath(p, prefixes) {
			return false
		}
		for _, row := range inv.manifest.Tree {
			if row.Path != "[remaining paths]" && excludedPath(p, []string{row.Path}) {
				return true
			}
		}
		return includeOverflow
	}
	root, e := os.OpenRoot(inv.root)
	if e != nil {
		return result, errFilesChanged
	}
	defer root.Close()
	f, e := os.OpenFile(result.filename, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return result, e
	}
	defer f.Close()
	hash := sha256.New()
	capped := &cappedWriter{w: io.MultiWriter(f, hash)}
	gz := gzip.NewWriter(capped)
	tw := tar.NewWriter(gz)
	total := 0
	hasHistory := false
	for _, p := range inv.paths {
		if allowed(p) {
			total++
			if strings.HasPrefix(p, ".git/") {
				hasHistory = true
			}
		}
	}
	if total == 0 {
		return result, errors.New("approval leaves no files to import")
	}
	// Tar creates parents of files, but empty refs/objects directories have no
	// file entries in an unborn repository. Preserve Git's structural skeleton
	// whenever approved history is present; these carry no additional files.
	if inv.manifest.Git != nil && inv.manifest.Git.HistoryIncluded && hasHistory {
		for _, name := range []string{".git", ".git/objects", ".git/refs", ".git/refs/heads", ".git/refs/tags", ".git/logs"} {
			if excludedPath(name, prefixes) {
				continue
			}
			if e = tw.WriteHeader(&tar.Header{Name: name, Mode: 0700, Typeflag: tar.TypeDir, Format: tar.FormatPAX}); e != nil {
				return result, e
			}
		}
	}
	var historyBytes, expandedBytes int64
	for _, p := range inv.paths {
		if e = ctx.Err(); e != nil {
			return result, e
		}
		if !allowed(p) {
			continue
		}
		data, info, e := readLocal(root, p)
		if e != nil {
			return result, e
		}
		if inv.files[p] != (fingerprint{sha256.Sum256(data), info.Mode(), info.ModTime().UnixNano()}) {
			return result, errFilesChanged
		}
		if strings.HasPrefix(p, ".git/") {
			historyBytes += int64(len(data))
			if inv.manifest.Git == nil || !inv.manifest.Git.HistoryIncluded || historyBytes > HistoryLimit {
				return result, errFilesChanged
			}
		}
		if p == ".git/config" {
			data, e = sanitizedConfig(ctx, data, dir)
			if e != nil {
				return result, e
			}
		}
		expandedBytes += int64(len(data))
		if expandedBytes > ExpandedLimit {
			return result, errors.New("archive expands past 1 GiB; narrow the import")
		}
		if e = tw.WriteHeader(&tar.Header{Name: p, Mode: int64(info.Mode().Perm() & 0777), ModTime: info.ModTime(), Size: int64(len(data)), Typeflag: tar.TypeReg, Format: tar.FormatPAX}); e != nil {
			return result, e
		}
		if _, e = tw.Write(data); e != nil {
			return result, e
		}
		result.files = append(result.files, p)
		if progress != nil {
			progress(len(result.files), total)
		}
	}
	if e = tw.Close(); e != nil {
		return result, e
	}
	if e = gz.Close(); e != nil {
		return result, e
	}
	if e = f.Close(); e != nil {
		return result, e
	}
	result.size = capped.n
	result.digest = hex.EncodeToString(hash.Sum(nil))
	return result, nil
}
