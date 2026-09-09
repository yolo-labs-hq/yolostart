# yolostart 0.3.1

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

The custom hostname `yolostart.sh` is live (operator-verified). `YOLOSTART_VERSION=0.2.0` pins the shell's release. For npm, use
`npx https://yolostart-sh.yolo.host/releases/0.2.0/yolostart-0.2.0.tgz`.
After registry publication, `npx yolostart@0.2.0` also works. Git is required for repository discovery and metadata.

## Import flow (0.3.1; server integration pending)

Without `--dry-run`, the CLI signs in, scans, creates an approval session, prints
the browser URL, and waits. The browser picks one candidate, its workspace name
and excluded path prefixes. The CLI packs only that candidate's scanned files,
PUTs a checksummed tar.gz directly to the presigned URL, finalizes, and requests a
workspace. Finalization and creation retry the same bundle ID on transient
failures. The workspace ID comes from session polling; only pod-reported
`seed.status: succeeded` produces a workspace URL. Denial, expiry, failure and
polling timeout exit unsuccessfully. Approval and seed polling each have a
20-minute limit. No terminal input is used.

`--dry-run` authenticates and prints JSON metadata on stdout. Tokens stay in
memory. After installation, its only network calls are device code creation and
token polling; it creates no approval session and uploads nothing. The npm
wrapper runs the same native program and flags.

Local HTTPS fixtures exercise the agreed S2/S4/S5 client contract; a real
browser-to-pod import awaits the server owner's branch and deployment. The
currently hosted tarball remains the earlier release until this change is
reviewed and shipped. Registry publication requires operator npm credentials.

`--scan ~/code` changes the starting directory. A repo at or above that
location wins; otherwise discovery examines children through depth two.
Multiple repos all become candidates, ordered by commit recency then mtime.
No repos yields one `adopt-dir` candidate. All import decisions belong to the
browser approval page. `--project <name-or-relative-path>` narrows
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

`GitInfo.historyBytes` measures aggregate logical regular-file bytes under
`.git`, without following symlinks. `historyIncluded` is true only for a local
`.git` directory at or below 25 MiB. Larger histories are omitted and reported
under `excluded.skipped`; their remote stays in the manifest for server recording.
Worktree `.git` pointers report zero bytes and `historyIncluded: false`.

The packer retains the scanned include list and hashes locally. Newly added
files never join the upload; changed/deleted files, changed modes, symlinks or
new secret-shaped JSON fail with `files-changed`. Exclusions match whole paths
or descendants (`src` does not exclude `src2`). Overflow paths hidden by the
`[remaining paths]` summary ship only with explicit browser `includeOverflow: true`;
the default omits them. Temporary archives contain
regular files only and are capped at 100 MiB compressed and 1 GiB expanded. They are removed on
completion or failure. SIGINT/SIGTERM allow bounded failure reporting and cleanup.

`.git/config` is rebuilt in the archive from portable format settings, clean
remotes and branch tracking. Credential helpers, HTTP headers, includes and local
commands and push URLs are dropped; the original config is unchanged. Hooks
are excluded and reported during scanning. Repositories requiring Git extensions
(such as SHA-256 object storage) fail locally rather than losing required settings.
Portable config is capped at 64 KiB, with 2048-byte values. Git history/objects are
**not secret-scanned**: committed secrets can remain, as browser approval must
explain. Working-tree secret exclusions remain mandatory.

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

Finalize retries a HEAD-miss refusal at most twice after PUT succeeds. The current
server uses `bundle-invalid` for both HEAD misses and invalid archives, so the
client matches the exact HEAD-miss message; other 4xx refusals are printed and
are neither retried nor overwritten by a client failure report.
