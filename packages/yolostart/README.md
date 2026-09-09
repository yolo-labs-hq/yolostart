# yolostart 0.2.0

One native CLI, two entry points:

- **Shell:** `curl -fsSL https://yolostart-sh.yolo.host | sh -s -- --dry-run`
  downloads a checksummed executable into a temporary directory and runs it.
  No Node, npm, Go, or system installation is needed. macOS and Linux on
  x64/arm64 are supported; Linux builds use `CGO_ENABLED=0`.
- **npm:** `npx https://yolostart-sh.yolo.host/yolostart.tgz --dry-run`
  runs the **same executable**, bundled in the
  npm package. The small Node wrapper verifies and unpacks the appropriate
  binary, forwards arguments/signals/exit status, and cleans its temporary
  directory on normal exit. There are no install scripts or extra downloads.
  The shorter `npx yolostart --dry-run` awaits npm registry publication.

The intended custom hostname is `yolostart.sh`; acquisition/DNS/TLS remain
pending. `YOLOSTART_VERSION=0.2.0` pins the shell's release. For npm, use
`npx https://yolostart-sh.yolo.host/releases/0.2.0/yolostart-0.2.0.tgz`.
After registry publication, `npx yolostart@0.2.0` also works. Git is required for repository discovery and metadata.

## Current scope: login, scan, dry-run

`--dry-run` signs in through the existing YOLO device flow, observes local
repositories, and prints JSON metadata on stdout. Progress goes to stderr.
Tokens stay in memory. After installation, the only network calls are device
code creation and token polling. No upload, approval session, workspace
creation, credential persistence, or terminal interaction is implemented.
Without `--dry-run`, the CLI explains that import is not yet available.

`--scan ~/code` changes the starting directory. A repo at or above that
location wins; otherwise discovery examines children through depth two.
Multiple repos all become candidates, ordered by commit recency then mtime.
No repos yields one `adopt-dir` candidate. All import decisions belong to the
future browser approval page. `--project <name-or-relative-path>` narrows
observation; duplicate names require the relative path. Other repos contribute
only names, never file metadata, when this explicit filter is used.

The JSON envelope remains `{ mode, candidates, otherRepos }`. Each candidate
has `kind` plus plan §4a's metadata. Local absolute roots and internal include
lists are never serialized. Secrets have no override: name exclusions precede
ignore rules, and JSON is inspected locally for credential fields. Symlinks,
special files, nested repos, dependencies, and build output are skipped.
Excluded directory names represent their complete subtrees. `gitignored` counts
inspected ignored files. The tree is capped at two path segments and 200 entries,
with overflow aggregated. Per-file ceiling: 25 MiB; include ceiling: 20,000 files.

Ordinary `.git` files are counted; worktree `.git` pointers are excluded and
reported because their targets are outside the selected root. Before S4, a
policy for credentials in Git history/config and a `.git` size ceiling are
still needed. Filename exclusions cannot sanitize opaque objects. Compressed
100 MiB enforcement belongs to the future packer. S1 uploads nothing.

## Development and release

Install Go 1.24+ and Node 20+ **on the build machine**, then `npm ci`.
`npm run build` compiles the wrapper and cross-compiles all four native targets.
Set `GO_BINARY` if Go isn't on PATH. Artifacts and SHA-256 manifests are generated
under `dist/native/<version>/`; Go source in `native/` is the only CLI logic.
Builds are cached by source digest, and cached artifacts are rehashed before use.

Run `npm run typecheck:test` and `npm test` (wrapper tests plus native Go tests).
`npm pack` includes the four compressed binaries; consumers need no compiler.
The host build copies those exact artifacts to `/releases/<version>/` and serves
`/releases/latest.txt`. Commit the version bump with behavior changes, verify a
preview, then promote. Keep prior version directories in release assets when
publishing subsequent versions so pinned shell installs remain available.

This native + optional npm architecture supersedes the plan's original
npm-only bootstrap choice at the operator's request. The plan is left unchanged.
