#!/bin/sh
# Inspect this script before running: curl -fsSL https://yolostart.sh
# Run: curl -fsSL https://yolostart.sh | sh -s -- --dry-run --scan ~/code
# Pin a release with YOLOSTART_VERSION; Node 20+ and npm must be installed.
# This bootstrapper only writes a temporary npm cache. Import decisions belong
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

if ! command -v node >/dev/null 2>&1 ||
   ! node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)'; then
    printf '%s\n' 'yolostart needs Node.js 20 or newer.' \
        'Install Node.js with npm from https://nodejs.org/en/download, then re-run.' >&2
    exit 1
fi
if ! command -v npx >/dev/null 2>&1; then
    printf '%s\n' 'npx is missing. Install Node.js with npm from https://nodejs.org/en/download.' >&2
    exit 1
fi
npm_config_cache=$(mktemp -d "${TMPDIR:-/tmp}/yolostart.XXXXXXXX")
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
