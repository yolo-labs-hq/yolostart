# yolostart 0.3.6

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

## Import flow (0.3.6; server integration pending)

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
Alternates, linked object directories and external Git object-store environment
settings also omit history (with `.git` reported as skipped). Local history
bytes still describe only the local `.git`; working-tree files remain eligible.
SSH/Git remote usernames are preserved, while passwords and HTTP userinfo are
removed.

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
preview, then promote. The host restores all prior versioned packages from the live release index and
verifies hashes before adding a version; unavailable archives stop the build.
See [host release retention](../../yolostart-sh/README.md) before deploying.

This native + optional npm architecture supersedes the plan's original
npm-only bootstrap choice at the operator's request. The plan is left unchanged.

Finalize retries a refusal at most twice when its envelope explicitly carries
`retryable: true` (currently only `upload-not-arrived`). Status codes and message
wording do not authorize a retry. Missing/false markers on other 4xx refusals
preserve the server verdict without a replacement client failure report.


## Automated npm release

[Publish yolostart](../../.github/workflows/publish-yolostart.yml) wakes on a
main-branch version bump and on successful same-repository push runs of
[`yolostart tests`](../../.github/workflows/yolostart-tests.yml). The second trigger
lets a test fix release an earlier failed bump without changing the version again.
An existing registry version is a no-op; only a 404 means it is unpublished.
Manual runs are main-only and default to `dry_run: true`.

The workflow pins Go 1.27.1, compiles Linux/macOS amd64/arm64, typechecks tests,
and packs once. It checks known credential shapes in the exact tarball and all
four decompressed binaries, validates their checksums, and clean-installs the
same tarball offline to run `--version` and `--help`. This heuristic scan is not
proof that all secrets are absent. The publisher rechecks the tarball digest and
uses the repository's `libnpmpublish`/`forceAuth` approach, with public access for
unscoped `yolostart`. It never repacks or invokes publish lifecycle scripts.

The operator must provision repository secret `NPM_TOKEN` with write access to
`yolostart`; missing credentials fail with `ENEEDAUTH`. No token is available to
the build/test/scan steps. Writing these workflows does not publish a release.

## Browser opening and endpoint overrides (0.3.6)

The device sign-in URL is always printed. The CLI also tries to open it using
macOS `open`, or Linux `xdg-open` when `DISPLAY` or `WAYLAND_DISPLAY` is set.
`BROWSER` takes precedence and names an executable or absolute executable path
(not a shell command); the URL is passed as a separate argument. A nonempty
`CI` variable or `--no-browser` suppresses automatic opening. Launch failure is
silent, and a launched browser never blocks sign-in polling or inherits input.

`YOLOSTART_API_URL` overrides `https://api.yolo.studio/v1` and
`YOLOSTART_APP_URL` overrides `https://yolo.studio`. Set the full API base,
including `/v1`. Each non-default target is printed once before sign-in on
stderr. Both accept HTTPS; local development may use HTTP only with the exact
host `localhost` or `127.0.0.1`. Credentials, query strings and fragments are
rejected. Device authentication still uses the existing shared auth service;
these overrides select the import API and approval/workspace web URLs.

For a piped installer, place variables on `sh` so the CLI inherits them:

```sh
curl -fsSL https://yolostart.sh/install.sh | \
  YOLOSTART_API_URL=https://staging-api.yolo.studio/v1 \
  YOLOSTART_APP_URL=https://staging.yolo.studio sh -s -- --no-browser --dry-run
```

The example targets must be deployed and configured to accept the sign-in token
before an import can succeed; overrides do not enable a dark server feature.
