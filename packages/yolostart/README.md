# yolostart (S1, 0.1.0)

`npx yolostart --dry-run` signs in through the existing YOLO device flow,
observes local repositories, and prints candidate metadata as JSON on stdout.
Progress goes to stderr. Tokens stay in memory. The only network requests are
device code creation and token polling; there is no upload, approval session,
workspace creation, or credential persistence. Running without `--dry-run`
reports that import is not yet available and exits nonzero.

Use `--scan ~/code` to change the starting directory. A repo at or above that
location wins; otherwise discovery examines children through depth two. Multiple
repos all become candidates, ordered by commit recency then directory mtime.
No repos produces one `adopt-dir` candidate. Every import decision belongs to
the future browser approval page. There is no terminal interaction or input.

An explicit `--project <name-or-relative-path>` narrows the scan to one discovered
repo. Duplicate names require the relative path. Unselected repos contribute
only names in `otherRepos`; their files are not scanned. This flag does not grant
upload permission. No Git repository is created locally.

The JSON envelope is `{ mode, candidates, otherRepos }`. Each candidate has a
`kind` (`repo` or `adopt-dir`) and the metadata from plan §4a. Absolute local
roots and the internal include-path lists are never serialized.

Secrets have no override. Name-based exclusions apply before ignore rules;
JSON files are inspected locally for service-account/private-key/client-secret
fields. Symlinks, special files, nested repos, dependencies, and build output
are skipped. Excluded directories represent the entire subtree in `skipped` or
`sensitive`; `gitignored` counts individually inspected ignored files. Tree
summary is capped at two path segments and 200 entries (overflow aggregated).
Files over 25 MiB are excluded; more than 20,000 included files refuses the scan.
The compressed size ceiling belongs to the future packer, not this metadata scan.

Ordinary `.git` files are counted, but a worktree's `.git` pointer is excluded
because its target is outside the selected root. Before S4, the plan needs a
policy for secrets embedded in Git history/config and a `.git` size ceiling:
filename exclusions cannot sanitize opaque Git objects. S1 uploads nothing.

Development: `npm ci`, `npm run build`, `npm run typecheck:test`, `npm test`.
