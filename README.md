# yolostart

Bootstrap a [YOLO Studio](https://yolo.studio) workspace from your terminal.

```sh
curl -fsSL https://yolostart.sh | sh   # native binary, no Node required
npx yolostart@latest                   # same binary via a thin npm bootstrap
```

## What's in this repo

| Path | What it is |
|---|---|
| [`packages/yolostart/`](packages/yolostart) | The `yolostart` CLI: a native Go executable plus the thin Node bootstrap published to npm as [`yolostart`](https://www.npmjs.com/package/yolostart). |
| [`yolostart-sh/`](yolostart-sh) | The Cloudflare Worker behind `yolostart.sh`. It serves the POSIX `install.sh`, the landing page and the versioned release files. |
| [`.github/scripts/yolostart-release-scan.py`](.github/scripts/yolostart-release-scan.py) | The release scanner that checks every packed artifact before it ships. |

The layout matches YOLO Labs' monorepo, so the relative paths between the two projects work unchanged.

## Source & contributing

This repository is a public mirror of those paths in YOLO Labs' private monorepo, which stays the source of truth. The mirror is synced automatically on every change. Releases (npm and native downloads) are built and published from the monorepo. Issues are welcome. Pull requests are welcome too: we apply them in the monorepo, keeping you as the author, and the change then syncs back here.

## License

MIT. See [LICENSE](LICENSE).
