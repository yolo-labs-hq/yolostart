# yolostart

One native CLI, two entry points:

- **Shell:** `curl -fsSL https://yolostart.sh | sh` downloads and runs the official
  native executable. No Node, npm, Go, or system installation is needed.
- **npm:** `npx yolostart` runs the same executable through a small Node 20+
  bootstrap. The direct tarball is also available at
  `https://yolostart-sh.yolo.host/yolostart.tgz`.

The **npm package and native CLI share the same version**, currently 0.3.15.
`npx yolostart@0.3.15` runs CLI 0.3.15. The thin tarball embeds all four platforms'
compressed and executable SHA-256 digests, verified at build time against the
native artifacts. By default it downloads only the current platform's gzip from
`https://yolostart-sh.yolo.host/releases/0.3.15/`; it fetches neither `latest.txt`
nor a manifest. Its integrity anchor is the npm tarball itself.

`YOLOSTART_VERSION` explicitly switches to **override mode**: that version's
manifest is fetched and both digests are checked against it instead. An explicit
`latest` override first resolves `latest.txt`. Error messages identify the pinned
(embedded digests) or override (fetched manifest) verification mode.

```sh
YOLOSTART_VERSION=0.3.11 npx https://yolostart-sh.yolo.host/yolostart.tgz --dry-run
curl -fsSL https://yolostart.sh | YOLOSTART_VERSION=0.3.15 sh -s -- --dry-run
```

The bootstrap has no dependencies or install hooks. It downloads at first **run**,
only for the current macOS/Linux x64/arm64 platform. It verifies SHA-256 of both
compressed and decompressed bytes, limits decompression to 64 MiB, and follows
only the shared allowlisted Host-to-dl artifact redirect. Verified gzip and
executable files are cached under
`${XDG_CACHE_HOME:-$HOME/.cache}/yolostart/<version>/`. Atomic temporary-file
renames make interrupted or concurrent downloads safe. Cache hits recheck both
digests; the default pinned mode works offline after caching, while override
mode always fetches its manifest. Remove that version's cache directory to evict it.
Arguments, terminal streams, signals and exit status pass through to the native CLI.
Download/verification failures exit without executing unverified bytes and point
to the shell installer. Git is required for repository discovery and metadata.

## Import flow

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
memory. The native CLI only calls device code creation and token polling; it
creates no approval session and uploads nothing. The npm bootstrap resolves and verifies its binary first, then runs that same
native program and flags.

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

Use Node 20+ and `npm ci`. `package.json` is the single version source for the
npm package, native binaries, Host release paths and dl publication. Bump it and
package-lock.json with CLI changes in the same commit.

First run `npm run pack:native` with Go installed (or `GO_BINARY` set). This
cross-builds all four targets and creates `dist/releases/yolostart-<version>.tgz`.
Then `npm run build` verifies those artifacts and embeds their digests in the
thin bootstrap. The wrapper compilation itself invokes no Go and never fetches
its trust anchors over the network. Missing or mismatched native artifacts stop
the build. Run `npm test`, `npm run typecheck:test` and `npm run test:native`.

`npm pack` uses an explicit small file allowlist; native binaries never enter it.
The deterministic native archive is separate and **not an installable npm package**.
Its legacy internal layout lets Host restore old and new pins together.
`scripts/check-native.mjs` scans that archive, requires all four executable targets,
and runs the current platform's executable offline. Publication always scans the
archive that actually contains executables, separately from scanning the thin tarball.

Host restores and verifies prior native archives, then adds the new release.
Its `/yolostart.tgz` alias serves the thin bootstrap separately.
See [host release retention](../../yolostart-sh/README.md) before deploying.

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

The npm workflow builds and scans all four native artifacts before embedding their
digests. It tests the bootstrap, scans the exact packed file
allowlist for credential patterns, then clean-installs and loads it offline with
install scripts disabled. This heuristic scan is not proof that all secrets are
absent. The publisher rechecks the tarball digest before publishing those exact
bytes. It never repacks. The job stays dark on **all** triggers, including manual
dry-runs, until `vars.YOLOSTART_PUBLISH_ENABLED='true'` is set by the operator.

The independent downloads workflow reads `package.json`, cross-builds and
scans the native archive and all four executables, and publishes verified immutable
objects to dl.yolo.studio. It never publishes to npm.

The operator must provision repository secret `NPM_TOKEN` with write access to
`yolostart`; missing credentials fail with `ENEEDAUTH`. No token is available to
the build/test/scan steps. Writing these workflows does not publish a release.

## Browser opening and endpoint overrides (0.3.6)

The device sign-in URL is always printed. The CLI also tries to open it using
macOS `open`, or Linux `xdg-open` when `DISPLAY` or `WAYLAND_DISPLAY` is set.
`BROWSER` takes precedence and names an executable or absolute executable path
(not a shell command); the URL is passed as a separate argument. A nonempty
`CI` variable or `--no-browser` suppresses automatic opening. Launch failure is
reported as a one-line fallback on stderr. CI suppression and missing desktop
sessions also explain why the browser did not open; explicit `--no-browser` stays
silent. A launched browser never blocks sign-in polling or inherits input.

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

Imported Git history includes the empty structural directories Git needs
(`objects`, `refs/heads`, `refs/tags`, and `logs`), even in an unborn repository
or one whose references are packed. Import preserves the source index and
commit state: it does not fabricate an initial commit for an unborn repository.
Regular-file mtimes are preserved in the archive and checked against the scan
snapshot. Arbitrary empty project directories are not represented by the file
manifest. Sanitized Git config groups keys into one block per section, keeps effective
scalar core settings and preserves multi-valued remote/branch settings.
Credentials and executable config settings remain excluded.

Git candidates explicitly report `git.unborn`. A single selected unborn repo
prints an advisory warning to stderr after scanning, before session creation
(or alongside the dry-run manifest): create the first commit locally and rerun
to rescan it. A multi-repo scan leaves the choice and warning to the approval
page. This warning never prompts, commits, or blocks an import.

Before npm publication (including publish-workflow dry-runs), all four platform
artifacts must be publicly available from both dl and the Host paths used by the
bootstrap. The gate extracts digest pins from the exact scanned npm tarball and
checks both compressed and executable bytes. Missing, changed or untrusted-redirect
responses fail the job before the credential-bearing publish step. A successful
dl upload alone is insufficient: Host must serve the version too. After native
publication and Host promotion, retry with workflow_dispatch. No package is
published while waiting for those release surfaces to become ready.
