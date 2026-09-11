#!/bin/sh
# POSIX bootstrapper. ASCII mark adapted from the YOLO octopus brand asset.
set -eu
if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then printf '\033[32m'; fi
cat <<'BANNER'
+------------------------------------------------------------------------------+
|          ######           YOLO STUDIO  /  FROM LOCAL TO CLOUD                |
|        ##########                                                            |
|       ##   ##   ##                        __           __             __     |
|       ##   ##   ##           __  ______  / /___  _____/ /_____ ______/ /_    |
|       ############          / / / / __ \/ / __ \/ ___/ __/ __ `/ ___/ __/    |
| ########################   / /_/ / /_/ / / /_/ (__  ) /_/ /_/ / /  / /_      |
|  ######## #### #######     \__, /\____/_/\____/____/\__/\__,_/_/   \__/      |
|    ###  #### ###  ###     /____/                                             |
|    #     ######     #                                                        |
|    #     ## ####    #     YOUR NEXT WORKSPACE STARTS HERE.                   |
|    ###   ##   ##  ###                                                        |
|      ##  #   ##  ##       Local work. Cloud possibilities.                   |
|         ## ###            You decide what comes along.                       |
|         ##                                                                   |
|          ###              EARLY ACCESS  /  IMPORTS ARE LIVE                  |
|                                                                              |
| START WITH A LOOK AROUND                                                     |
|   1. Run from your project folder, or use --scan ~/code.                     |
|   2. Sign in through the browser link printed below.                         |
|   3. Read the manifest: candidates, file counts, and exclusions.             |
|                                                                              |
| QUICK START  /  NO NODE OR NPM REQUIRED                                      |
|   curl -fsSL https://yolostart-sh.yolo.host | sh -s -- --dry-run             |
|                                                                              |
| MAKE IT YOURS                                                                |
|   --scan ~/code       Look for projects in a different directory.            |
|   --project my-app    Limit the scan to one named repository.                |
|   YOLOSTART_VERSION  Pin a CLI release instead of using latest.              |
|                                                                              |
| YOUR WORK, YOUR CALL                                                         |
|   Native executable. No Node, npm, or Go installation needed.                |
|   No sudo. Dry runs upload nothing. Secret files stay excluded.              |
|   Approve what comes along, then it lands in a running workspace.            |
|                                                                              |
| PREFER NPX?  /  SAME NATIVE CLI                                              |
|   npx yolostart                                                              |
|   A small wrapper that downloads this same verified binary.                  |
|   Explore YOLO Studio: https://yolo.studio                                   |
|   Read this script before running it. The code starts below.                 |
+------------------------------------------------------------------------------+
BANNER
if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then printf '\033[0m'; fi
printf '\n'

fail() { printf 'yolostart: %s\n' "$*" >&2; exit 1; }
case "$(uname -s):$(uname -m)" in
    Linux:x86_64) platform=linux-amd64 ;;
    Linux:aarch64|Linux:arm64) platform=linux-arm64 ;;
    Darwin:x86_64) platform=darwin-amd64 ;;
    Darwin:arm64) platform=darwin-arm64 ;;
    *) fail 'Supported platforms: macOS/Linux on x64/arm64.' ;;
esac
for tool_name in curl gzip awk chmod; do
    command -v "$tool_name" >/dev/null 2>&1 || fail "Install $tool_name and re-run."
done
if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
elif command -v shasum >/dev/null 2>&1; then checksum=shasum
else fail 'Install sha256sum or shasum and re-run.'; fi
work=$(mktemp -d "${TMPDIR:-/tmp}/yolostart.XXXXXXXX")
base=https://yolostart-sh.yolo.host/releases
fetch() {
    curl -fsSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 120 \
        "$1" -o "$2" || fail 'Download failed; re-run to retry.'
}
version=${YOLOSTART_VERSION:-latest}
if [ "$version" = latest ]; then
    fetch "$base/latest.txt" "$work/latest.txt"
    version=$(cat "$work/latest.txt")
fi
case "$version" in ''|.*|-*|*[!a-zA-Z0-9.-]*) fail 'Invalid YOLOSTART_VERSION.' ;; esac
asset=yolostart-$platform.gz
printf 'Fetching yolostart %s (%s); no runtime installation needed.\n' "$version" "$platform" >&2
fetch "$base/$version/SHA256SUMS" "$work/SHA256SUMS"
fetch "$base/$version/$asset" "$work/$asset"
expected=$(awk -v name="$asset" '$2 == name { print $1 }' "$work/SHA256SUMS")
[ "${#expected}" -eq 64 ] || fail 'Missing or invalid release checksum.'
if [ "$checksum" = sha256sum ]; then actual=$(sha256sum "$work/$asset")
else actual=$(shasum -a 256 "$work/$asset"); fi
[ "${actual%% *}" = "$expected" ] || fail 'Checksum mismatch; refusing to execute.'
gzip -dc "$work/$asset" > "$work/yolostart" || fail 'Executable decompression failed.'
chmod 700 "$work/yolostart"
YOLOSTART_ENTRYPOINT=shell exec "$work/yolostart" "$@"
