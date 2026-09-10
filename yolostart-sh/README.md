# yolostart.sh release retention

The Worker still serves the exact POSIX `install.sh` at `/`, plus versioned
native files and npm tarballs. `build.mjs` restores prior releases before adding
the current version. No deploy or storage credentials are used by the build.

The durable source is the **active production asset store**, not preview URLs:
YOLO Host keeps the active release but can garbage-collect superseded previews.
Each deployment carries every prior archive and native file forward. The mutable
`/releases/index.json` lists immutable package versions, byte lengths and SHA-256
hashes, and is served/fetched without caching. Builds download each versioned
npm tarball from the stable host, verify its hash and package identity, then
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
