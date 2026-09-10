package yolostart

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/go-git/go-git/v5/plumbing/format/gitignore"
)

type Candidate struct {
	Root, Name, LastCommitAt string
	Mtime                    time.Time
}
type Resolution struct {
	Root, Mode string
	Candidates []Candidate
}
type GitInfo struct {
	Unborn          bool    `json:"unborn"`
	Remote          *string `json:"remote"`
	Branch          *string `json:"branch"`
	LastCommitAt    *string `json:"lastCommitAt"`
	Dirty           bool    `json:"dirty"`
	HistoryBytes    int64   `json:"historyBytes"`
	HistoryIncluded bool    `json:"historyIncluded"`
}
type TreeEntry struct {
	Path      string `json:"path"`
	FileCount int    `json:"fileCount"`
	Bytes     int64  `json:"bytes"`
}
type Excluded struct {
	Gitignored int      `json:"gitignored"`
	Sensitive  []string `json:"sensitive"`
	Oversize   []string `json:"oversize"`
	Skipped    []string `json:"skipped"`
}
type Manifest struct {
	Kind      string      `json:"kind"`
	Name      string      `json:"name"`
	RelPath   string      `json:"relPath"`
	Git       *GitInfo    `json:"git"`
	FileCount int         `json:"fileCount"`
	Bytes     int64       `json:"bytes"`
	Tree      []TreeEntry `json:"tree"`
	Excluded  Excluded    `json:"excluded"`
}
type ScanManifest struct {
	Mode       string     `json:"mode"`
	Candidates []Manifest `json:"candidates"`
	OtherRepos []string   `json:"otherRepos"`
}

var skipped = map[string]bool{"node_modules": true, "dist": true, "build": true, "out": true, "coverage": true, ".next": true, ".nuxt": true, ".cache": true, ".turbo": true, "target": true, "vendor": true, "__pycache__": true}
var secretName = regexp.MustCompile(`(?i)^(?:\.env.*|.*\.pem|id_rsa.*|.*\.key|credentials\.json|\.aws|\.ssh|\.npmrc|\.netrc|\.npmtoken|.*service[-_]?account.*\.json)$`)
var secretJSON = regexp.MustCompile(`"(?:private_key|private_key_id|client_secret)"\s*:|"type"\s*:\s*"service_account"`)

func sensitivePath(path string) bool {
	for _, part := range strings.Split(filepath.ToSlash(path), "/") {
		if secretName.MatchString(part) {
			return true
		}
	}
	return false
}
func sensitiveJSON(data []byte) bool {
	if secretJSON.Match(data) {
		return true
	}
	var decoded any
	if json.Unmarshal(data, &decoded) != nil {
		return false
	}
	pending := []any{decoded}
	for len(pending) > 0 {
		v := pending[len(pending)-1]
		pending = pending[:len(pending)-1]
		switch x := v.(type) {
		case map[string]any:
			for k, child := range x {
				if k == "private_key" || k == "private_key_id" || k == "client_secret" || (k == "type" && child == "service_account") {
					return true
				}
				pending = append(pending, child)
			}
		case []any:
			pending = append(pending, x...)
		}
	}
	return false
}
func git(root string, args ...string) string {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", root}, args...)...)
	cmd.Env = append(os.Environ(), "GIT_OPTIONAL_LOCKS=0", "GIT_TERMINAL_PROMPT=0")
	b, err := cmd.Output()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
func candidate(root string) (Candidate, error) {
	s, err := os.Stat(root)
	if err != nil {
		return Candidate{}, err
	}
	return Candidate{Root: root, Name: filepath.Base(root), LastCommitAt: git(root, "log", "-1", "--format=%cI"), Mtime: s.ModTime()}, nil
}
func canonical(path string) (string, error) {
	p, e := filepath.Abs(path)
	if e != nil {
		return "", e
	}
	return filepath.EvalSymlinks(p)
}
func rulesFor(root, relative string, inherited []gitignore.Pattern) ([]gitignore.Pattern, error) {
	rules := append([]gitignore.Pattern{}, inherited...)
	filename := filepath.Join(root, relative, ".gitignore")
	s, e := os.Lstat(filename)
	if os.IsNotExist(e) {
		return rules, nil
	}
	if e != nil {
		return nil, e
	}
	if !s.Mode().IsRegular() {
		return rules, nil
	}
	if s.Size() > 1<<20 {
		return nil, errors.New(".gitignore exceeds 1 MiB; refusing to ignore its rules")
	}
	data, e := os.ReadFile(filename)
	if e != nil {
		return nil, e
	}
	var domain []string
	if relative != "" {
		domain = strings.Split(filepath.ToSlash(relative), "/")
	}
	for _, line := range strings.Split(string(data), "\n") {
		if line != "" && !strings.HasPrefix(line, "#") {
			rules = append(rules, gitignore.ParsePattern(strings.TrimSuffix(line, "\r"), domain))
		}
	}
	return rules, nil
}
func ignored(path string, dir bool, rules []gitignore.Pattern) bool {
	return gitignore.NewMatcher(rules).Match(strings.Split(filepath.ToSlash(path), "/"), dir)
}
func Resolve(start string) (Resolution, error) {
	if _, e := exec.LookPath("git"); e != nil {
		return Resolution{}, errors.New("Git is required to identify repositories; install Git and re-run")
	}
	root, e := canonical(start)
	if e != nil {
		return Resolution{}, e
	}
	s, e := os.Stat(root)
	if e != nil {
		return Resolution{}, e
	}
	if !s.IsDir() {
		return Resolution{}, errors.New("--scan must name a directory")
	}
	r := Resolution{Root: root, Mode: "plain", Candidates: []Candidate{}}
	if parent := git(root, "rev-parse", "--show-toplevel"); parent != "" {
		parent, e = canonical(parent)
		if e != nil {
			return r, e
		}
		c, e := candidate(parent)
		r.Mode = "single"
		r.Candidates = append(r.Candidates, c)
		return r, e
	}
	var visit func(string, int, []gitignore.Pattern) error
	visit = func(relative string, depth int, inherited []gitignore.Pattern) error {
		if depth == 2 {
			return nil
		}
		rules, e := rulesFor(root, relative, inherited)
		if e != nil {
			return e
		}
		entries, e := os.ReadDir(filepath.Join(root, relative))
		if e != nil {
			return e
		}
		for _, entry := range entries {
			if !entry.IsDir() || entry.Name() == ".git" || skipped[entry.Name()] || sensitivePath(entry.Name()) {
				continue
			}
			rel := filepath.Join(relative, entry.Name())
			if ignored(rel, true, rules) {
				continue
			}
			child := filepath.Join(root, rel)
			marker, e := os.Lstat(filepath.Join(child, ".git"))
			if e != nil && !os.IsNotExist(e) {
				return e
			}
			detected := ""
			if e == nil && marker.Mode()&os.ModeSymlink == 0 {
				detected = git(child, "rev-parse", "--show-toplevel")
			}
			if detected != "" {
				detected, e = canonical(detected)
				if e != nil {
					return e
				}
			}
			if detected == child {
				c, e := candidate(child)
				if e != nil {
					return e
				}
				r.Candidates = append(r.Candidates, c)
			} else if e = visit(rel, depth+1, rules); e != nil {
				return e
			}
		}
		return nil
	}
	if e = visit("", 0, nil); e != nil {
		return r, e
	}
	sort.SliceStable(r.Candidates, func(i, j int) bool {
		a, b := r.Candidates[i], r.Candidates[j]
		at, _ := time.Parse(time.RFC3339, a.LastCommitAt)
		bt, _ := time.Parse(time.RFC3339, b.LastCommitAt)
		if !at.Equal(bt) {
			return at.After(bt)
		}
		if !a.Mtime.Equal(b.Mtime) {
			return a.Mtime.After(b.Mtime)
		}
		return a.Root < b.Root
	})
	if len(r.Candidates) == 1 {
		r.Mode = "single"
	} else if len(r.Candidates) > 1 {
		r.Mode = "picker"
	}
	return r, nil
}
func Select(r Resolution, project string) (*Candidate, error) {
	if project != "" {
		var matches []Candidate
		for _, c := range r.Candidates {
			rel, _ := filepath.Rel(r.Root, c.Root)
			if c.Name == project || filepath.ToSlash(rel) == filepath.ToSlash(project) {
				matches = append(matches, c)
			}
		}
		if len(matches) != 1 {
			return nil, errors.New("--project must uniquely identify one discovered repo; use a relative path for duplicate names")
		}
		return &matches[0], nil
	}
	if r.Mode == "single" {
		return &r.Candidates[0], nil
	}
	return nil, nil
}
func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

var scpRemote = regexp.MustCompile(`^[\w.-]+@[\w.-]+:[\w./-]+$`)

func safeRemote(s string) *string {
	u, e := url.Parse(s)
	if e == nil {
		u.Scheme = strings.ToLower(u.Scheme)
	}
	if e == nil && u.Host != "" && (u.Scheme == "http" || u.Scheme == "https" || u.Scheme == "ssh" || u.Scheme == "git" || u.Scheme == "git+ssh" || u.Scheme == "ssh+git") {
		if u.Scheme == "http" || u.Scheme == "https" {
			u.User = nil
		} else if u.User != nil {
			if u.User.Username() == "" {
				return nil
			}
			u.User = url.User(u.User.Username())
		}
		u.RawQuery = ""
		u.Fragment = ""
		return nullable(u.String())
	}
	if scpRemote.MatchString(s) {
		return nullable(s)
	}
	return nil
}

// HistoryLimit measures logical regular-file bytes, without following links.
const HistoryLimit int64 = 25 << 20

func historySize(root string) (int64, bool, error) {
	marker := filepath.Join(root, ".git")
	info, err := os.Lstat(marker)
	if os.IsNotExist(err) {
		return 0, false, nil
	}
	if err != nil {
		return 0, false, err
	}
	if !info.IsDir() {
		return 0, false, nil
	} // Worktree pointers are not portable history.
	var total int64
	err = filepath.WalkDir(marker, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			total += info.Size()
		}
		return nil
	})
	if err != nil {
		return total, false, err
	}
	// Even a small local .git can depend on an external object database. Never
	// follow or upload its machine-specific pointer; keep the working tree only.
	if _, err = os.Lstat(filepath.Join(marker, "objects", "info", "alternates")); err == nil {
		return total, false, nil
	} else if !os.IsNotExist(err) {
		return total, false, err
	}
	if objects, err := os.Lstat(filepath.Join(marker, "objects")); err == nil && objects.Mode()&os.ModeSymlink != 0 {
		return total, false, nil
	} else if err != nil && !os.IsNotExist(err) {
		return total, false, err
	}
	if _, err := os.Lstat(filepath.Join(marker, "commondir")); err == nil {
		return total, false, nil
	} else if !os.IsNotExist(err) {
		return total, false, err
	}
	if os.Getenv("GIT_ALTERNATE_OBJECT_DIRECTORIES") != "" || os.Getenv("GIT_OBJECT_DIRECTORY") != "" || os.Getenv("GIT_COMMON_DIR") != "" {
		return total, false, nil
	}
	return total, true, nil
}

func BuildManifest(root, scanRoot string, isRepo bool) (Manifest, []string, error) {
	rel, e := filepath.Rel(scanRoot, root)
	if e != nil {
		return Manifest{}, nil, e
	}
	m := Manifest{Kind: "adopt-dir", Name: filepath.Base(root), RelPath: filepath.ToSlash(rel), Tree: []TreeEntry{}, Excluded: Excluded{Sensitive: []string{}, Oversize: []string{}, Skipped: []string{}}}
	if isRepo {
		m.Kind = "repo"
		m.Git = &GitInfo{Unborn: git(root, "rev-parse", "--verify", "HEAD") == "", Remote: safeRemote(git(root, "remote", "get-url", "origin")), Branch: nullable(git(root, "symbolic-ref", "--short", "HEAD")), LastCommitAt: nullable(git(root, "log", "-1", "--format=%cI")), Dirty: git(root, "status", "--porcelain", "--untracked-files=normal") != ""}
	}
	if m.Git != nil {
		size, available, err := historySize(root)
		if err != nil {
			return m, nil, err
		}
		m.Git.HistoryBytes = size
		m.Git.HistoryIncluded = available && size <= HistoryLimit
		if !m.Git.HistoryIncluded {
			m.Excluded.Skipped = append(m.Excluded.Skipped, ".git")
		}
	}
	includes := []string{}
	summary := map[string]int{}
	var visit func(string, []gitignore.Pattern, bool) error
	visit = func(relative string, inherited []gitignore.Pattern, parentIgnored bool) error {
		rules, e := rulesFor(root, relative, inherited)
		if e != nil {
			return e
		}
		entries, e := os.ReadDir(filepath.Join(root, relative))
		if e != nil {
			return e
		}
		for _, entry := range entries {
			rel := filepath.ToSlash(filepath.Join(relative, entry.Name()))
			full := filepath.Join(root, rel)
			if rel == ".git" && (m.Git == nil || !m.Git.HistoryIncluded) {
				if m.Git == nil {
					m.Excluded.Skipped = append(m.Excluded.Skipped, rel)
				}
				continue
			}
			if rel == ".git/hooks" {
				m.Excluded.Skipped = append(m.Excluded.Skipped, rel)
				continue
			}
			if sensitivePath(rel) {
				m.Excluded.Sensitive = append(m.Excluded.Sensitive, rel)
				continue
			}
			info, e := os.Lstat(full)
			if e != nil {
				return e
			}
			if info.Mode()&os.ModeSymlink != 0 || (!info.IsDir() && !info.Mode().IsRegular()) {
				m.Excluded.Skipped = append(m.Excluded.Skipped, rel)
				continue
			}
			if info.IsDir() && skipped[entry.Name()] {
				m.Excluded.Skipped = append(m.Excluded.Skipped, rel)
				continue
			}
			if info.IsDir() && entry.Name() != ".git" {
				_, e := os.Lstat(filepath.Join(full, ".git"))
				if e == nil {
					m.Excluded.Skipped = append(m.Excluded.Skipped, rel)
					continue
				}
				if !os.IsNotExist(e) {
					return e
				}
			}
			if entry.Name() == ".git" && !info.IsDir() {
				if m.Git == nil || m.Git.HistoryIncluded {
					m.Excluded.Skipped = append(m.Excluded.Skipped, rel)
				}
				continue
			}
			isIgnored := parentIgnored || (rel != ".git" && !strings.HasPrefix(rel, ".git/") && ignored(rel, info.IsDir(), rules))
			if info.IsDir() {
				if e = visit(rel, rules, isIgnored); e != nil {
					return e
				}
				continue
			}
			if info.Size() > 25<<20 {
				m.Excluded.Oversize = append(m.Excluded.Oversize, rel)
				continue
			}
			if strings.HasSuffix(strings.ToLower(entry.Name()), ".json") {
				data, e := os.ReadFile(full)
				if e != nil {
					return e
				}
				if sensitiveJSON(data) {
					m.Excluded.Sensitive = append(m.Excluded.Sensitive, rel)
					continue
				}
			}
			if strings.HasPrefix(rel, ".git/") && (m.Git == nil || !m.Git.HistoryIncluded) {
				continue
			}
			if isIgnored {
				m.Excluded.Gitignored++
				continue
			}
			if len(includes) >= 20000 {
				return errors.New("import exceeds 20,000 files; narrow the project before re-running")
			}
			includes = append(includes, rel)
			m.FileCount++
			m.Bytes += info.Size()
			parts := strings.Split(rel, "/")
			key := strings.Join(parts[:min(2, len(parts))], "/")
			if _, ok := summary[key]; !ok && len(summary) >= 199 {
				key = "[remaining paths]"
			}
			index, ok := summary[key]
			if !ok {
				index = len(m.Tree)
				summary[key] = index
				m.Tree = append(m.Tree, TreeEntry{Path: key})
			}
			m.Tree[index].FileCount++
			m.Tree[index].Bytes += info.Size()
		}
		return nil
	}
	e = visit("", nil, false)
	return m, includes, e
}
func Scan(start, project string) (ScanManifest, error) {
	r, e := Resolve(start)
	if e != nil {
		return ScanManifest{}, e
	}
	selected, e := Select(r, project)
	if e != nil {
		return ScanManifest{}, e
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
		m, _, e := BuildManifest(r.Root, r.Root, false)
		out.Candidates = append(out.Candidates, m)
		return out, e
	}
	for _, c := range candidates {
		m, _, e := BuildManifest(c.Root, r.Root, true)
		if e != nil {
			return out, fmt.Errorf("scan %s: %w", c.Name, e)
		}
		out.Candidates = append(out.Candidates, m)
	}
	return out, nil
}
