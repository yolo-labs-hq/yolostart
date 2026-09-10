# yolostart.sh release retention

The Worker serves a static landing page at `/` for `Sec-Fetch-Dest: document`
or an `Accept` header containing `text/html`. Every other root request receives
the exact POSIX `install.sh`. `/install.sh` and `/?raw` always serve the script,
including in a browser. No User-Agent detection is used. Both responses carry
`Vary: Accept, Sec-Fetch-Dest` and `Cache-Control: no-store` to isolate variants.
`landing.html` has inline CSS and one inline clipboard script, with no external assets; its banner
is embedded from the installer at build time. No installer bytes change.

The Worker also serves versioned native files and release archives, plus a separate thin npm bootstrap. `build.mjs` restores prior releases before adding
the current version. No deploy or storage credentials are used by the build.

The durable source is the **active production asset store**, not preview URLs:
YOLO Host keeps the active release but can garbage-collect superseded previews.
Each deployment carries every prior archive and native file forward. The mutable
`/releases/index.json` lists immutable native versions, byte lengths and SHA-256
hashes, and is served/fetched without caching. Builds download each versioned
release archive from the stable host, verify its hash and package identity, then
restore its native artifacts and checksums. Local ignored build folders are
never treated as the archive.

`releases.json` bootstraps the first index with the already-live 0.2.0 tarball's
verified hash. When the live index does not yet exist (404), the live `latest.txt`
must identify a committed bootstrap version. Otherwise the build refuses to
proceed. A missing/corrupt archive, changed committed pin, invalid inventory or
attempt to replace the bytes of an existing version also stops the build.

New packages are packed from a clean temporary tree containing only their own
version's native artifacts. All assembled assets replace `dist/assets` only
after restoration and validation succeed. Building alone does not alter the
host; a failed build must not be bypassed during deployment.

Serialize production deployments. Rebuild against the current live inventory
immediately before shipping; do not promote an old preview built before a newer
version was published. Keep the existing live site in place until its successor
has restored the full inventory. Never remove release records to work around
storage limits: the versioned URLs are a retention promise, and storage capacity
must accommodate the retained archives. The committed bootstrap inventory may
be extended with reviewed live hashes, never rewritten to bless changed bytes.

Verification: `npm test` builds with real public release restoration and runs
Worker/bootstrap tests plus isolated restoration fixtures. The latter simulate
a second build into an empty directory, preservation of all four native targets
and both tarballs, changed bytes, missing archives and missing inventory.

## Separate R2 downloads (dark)

`.github/workflows/publish-yolostart-downloads.yml` publishes native releases to
`https://dl.yolo.studio/yolostart/<version>/`, using the historical yolomax bucket
`yolostudio-dl` (`R2_DL_BUCKET_NAME` override). It is independent of npm publishing.
The job requires repository variable `YOLOSTART_DL_PUBLISH_ENABLED` to equal
`true` on every trigger, including manual dry-runs. Absent means skipped. Pushes
to main and successful same-repository main push runs of `yolostart tests` wake
it; workflow_run checks out the tested SHA. PRs/forks cannot enter the job.

After review/merge and an operator enable, dispatch with `dry_run=true` to build
all four targets, run tests, scan the exact native archive and decompressed
executables, and run its current-platform binary offline. `dry_run=false` uploads.
The existing `Production` environment secrets `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`,
and `R2_SECRET_ACCESS_KEY` are the historical distribution credential path;
no new GitHub secret or GSM read/IAM grant is introduced. Inventory §1 documents
this path separately from the running-service GSM credentials. Their current
presence and write grant to the downloads bucket are not proven by repo code;
missing/denied credentials fail loudly. The bucket override is optional.

Each version contains raw `yolostart-{linux,darwin}-{amd64,arm64}` executables,
the corresponding `.gz` files, `SHASUMS256.txt`, `manifest.json`, notices, and
the native release archive. All are derived from one scanned archive snapshot. Conditional
creation refuses changed bytes at existing paths; identical retries work.
Versioned objects are read back from R2 and verified byte-for-byte over public
HTTPS. Only then is `yolostart/latest/manifest.json` advanced, as one no-store
object, using compare-and-swap. Installers can resolve its version then fetch
immutable paths. Older releases cannot roll latest backward; a partial upload
or failed latest update can be retried. Do not expire these release objects via
bucket lifecycle rules (unlike short-lived import bundles in another prefix).

DNS failure for `dl.yolo.studio` was reported from the sandbox; the 2026-09-10
recheck resolved and returned HTTP 404 at `/`. Neither result proves the artifact
binding. Post-upload public verification is the operator's first real signal.
The installer and Host retention build still use their working Host origin;
cutover is separate work after R2 downloads verify, retaining all existing Host
version URLs. This workflow creates no bucket, changes no DNS, deploys no Worker,
and publishes nothing to npm.

## Host asset capacity

The third native release exceeds Host's 50 MiB bundle cap if every archive and
compressed executable is copied into each deployment. The build still restores
and verifies the entire historical inventory first. When its asset tree exceeds
49 MiB (leaving room for Worker code), it looks for identical versioned tarballs
and gzip executables in the existing `dl.yolo.studio/yolostart/<version>/` store.
Only a complete set verified byte-for-byte is removed from the local asset
bundle; old releases absent from that bucket remain on Host. Checksums, manifest
and notices remain local, and every old `/releases/<version>/...` URL survives.

The Worker redirects each externally stored payload to the exact versioned URL
verified at build time. This avoids a Worker-to-downloads request being refused
by the edge while ordinary client requests work. The installer follows the
HTTPS redirect and verifies its existing checksum before execution. Clean
release restoration permits only an exact artifact redirect to the known
`dl.yolo.studio/yolostart/<version>/<filename>` destination, then verifies the
archive against its pinned digest and size. Other redirects remain refused.
The existing downloads bucket must retain these immutable objects; no bucket,
credential or DNS change is needed. If sufficient identical copies cannot be
verified at build time, the build stops rather than discarding pins or shipping
an oversized bundle. Public verification uses the same product User-Agent as
the downloads workflow.

Favicons are embedded into the Worker at build time from `icons/`: the emerald octopus SVG from `assets/octopus-emerald.svg`, and the existing webapp 32px/180px brand PNGs (32px wrapped as ICO). Icon routes cache for one day; HTML remains uncached. No external icon requests or installer changes.

## Independent npm bootstrap

`packages/yolostart/native/version.json` controls native releases and `latest.txt`.
`packages/yolostart/package.json` controls the thin npm bootstrap's separate 1.x
version line. Build native releases with `npm run pack:native`; do not use npm pack
as the native archive builder. New release archives retain legacy internal paths
for restoration but identify as private `yolostart-native-release`, not an installable
npm package. Historical archives remain byte-identical.

The unversioned `/yolostart.tgz` alias serves the separately packed thin bootstrap
from `/bootstrap/yolostart-<bootstrap-version>.tgz`, with no-store on the alias.
That package downloads only the running platform's native bytes at runtime, using
the same release base and redirect policy as the shell/Host restoration path.
A native release does not require an npm version bump or npm publication.
