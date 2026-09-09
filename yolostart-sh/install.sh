#!/bin/sh
# Inspect this script before running: curl -fsSL https://yolostart.sh
# Run: curl -fsSL https://yolostart.sh | sh -s -- --dry-run --scan ~/code
# Pin the CLI with YOLOSTART_VERSION. Missing Node/npm is fetched temporarily.
# This bootstrapper only writes temporary runtime/cache files. Decisions belong
# to browser approval. Currently only --dry-run is available; nothing uploads.
set -eu

if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then printf '\033[36m'; fi
cat <<'BANNER'
                __           __             __
   __  ______  / /___  _____/ /_____ ______/ /_
  / / / / __ \/ / __ \/ ___/ __/ __ `/ ___/ __/
 / /_/ / /_/ / / /_/ (__  ) /_/ /_/ / /  / /_
 \__, /\____/_/\____/____/\__/\__,_/_/   \__/
/____/
BANNER
if [ -t 1 ] && [ "${NO_COLOR+x}" != x ]; then printf '\033[0m'; fi
printf '\nPreview a local project for YOLO Studio. Nothing uploads.\n\n'

fail() { printf 'yolostart: %s\n' "$*" >&2; exit 1; }
npm_config_cache=$(mktemp -d "${TMPDIR:-/tmp}/yolostart.XXXXXXXX")
if ! command -v node >/dev/null 2>&1 ||
   ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
   ! command -v npx >/dev/null 2>&1; then
    # Official Node v24.21.0 tarballs; hashes pinned from its SHASUMS256.txt.
    case "$(uname -s):$(uname -m)" in
        Linux:x86_64) platform=linux-x64; digest=6e1db87ef58b8819e5d5402eff1536491b18edd8eb7bee5ef7897876e88dc5ff ;;
        Linux:aarch64|Linux:arm64) platform=linux-arm64; digest=724282c3b43aec998aa9527380465b45d229e021b58035f5f4f63095eabfe5d5 ;;
        Darwin:x86_64) platform=darwin-x64; digest=1462cb3b3046b815cf8ea436d3da450ec1a9f11dac7e5a46b0ada5305d7e8097 ;;
        Darwin:arm64) platform=darwin-arm64; digest=bed7eea5325e1108f32ce5228ddd6a5f0f08a499ee42aa7442aea583702f6057 ;;
        *) fail 'Automatic runtime download supports macOS/Linux on x64/arm64. Install Node 20+ with npm from https://nodejs.org/en/download and re-run.' ;;
    esac
    command -v curl >/dev/null 2>&1 || fail 'Install curl and re-run.'
    command -v tar >/dev/null 2>&1 || fail 'Install tar and re-run.'
    if command -v sha256sum >/dev/null 2>&1; then checksum=sha256sum
    elif command -v shasum >/dev/null 2>&1; then checksum=shasum
    else fail 'Install sha256sum or shasum and re-run.'; fi
    runtime=node-v24.21.0-$platform
    archive=$npm_config_cache/runtime.tar.gz
    printf '%s\n' 'Fetching a temporary Node runtime; no system installation is needed.' >&2
    curl -fSL --proto '=https' --tlsv1.2 --connect-timeout 15 --max-time 300 \
        "https://nodejs.org/dist/v24.21.0/$runtime.tar.gz" -o "$archive" || fail 'Runtime download failed. Re-run to retry.'
    if [ "$checksum" = sha256sum ]; then actual=$(sha256sum "$archive")
    else actual=$(shasum -a 256 "$archive"); fi
    [ "${actual%% *}" = "$digest" ] || fail 'Runtime checksum mismatch; refusing to extract or execute it.'
    tar -xzf "$archive" -C "$npm_config_cache" || fail 'Runtime extraction failed.'
    PATH=$npm_config_cache/$runtime/bin:$PATH
    export PATH
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' ||
        fail 'This runtime cannot run on your OS. Install a compatible Node 20+ with npm and re-run.'
fi
# npm accepts both cases; inherited uppercase config must not override this.
NPM_CONFIG_CACHE=$npm_config_cache
npm_config_logs_dir=$npm_config_cache/_logs
NPM_CONFIG_LOGS_DIR=$npm_config_logs_dir
export npm_config_cache NPM_CONFIG_CACHE npm_config_logs_dir NPM_CONFIG_LOGS_DIR
# stdin may still be the script pipe. A terminal is optional, never required.
if [ -r /dev/tty ] && ( : < /dev/tty ) 2>/dev/null; then
    exec npx -y yolostart@"${YOLOSTART_VERSION:-latest}" "$@" < /dev/tty
fi
exec npx -y yolostart@"${YOLOSTART_VERSION:-latest}" "$@"
