"""Inspect the exact bootstrap tarball or native release archive and executables.

Known credential shapes are heuristic, not proof that all secrets are absent.
Go's crypto runtime embeds PEM label strings; require a complete private-key
payload rather than flagging its parser's label constants as credentials.
Never print matching bytes, which would disclose a detected secret to CI logs.
"""
import gzip
import hashlib
import io
import json
import os
import re
import sys
import tarfile
from pathlib import Path, PurePosixPath

PATTERNS = [
    rb'eTNTGQM7JkCU3TD2BC2xDR8X|tAdPQ9wYuqi1uFmy8TyAC8VF|betterstackdata\.com',
    rb'JWT_SECRET\s*[:=]\s*["\x27][A-Za-z0-9]|INTERNAL_API_KEY\s*[:=]\s*["\x27][A-Za-z0-9]',
    rb'AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{35}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}',
    rb'xox[baprs]-[A-Za-z0-9-]+|npm_[A-Za-z0-9]{36}|\.svc\.cluster\.local',
    rb'-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----\s*[A-Za-z0-9+/=\r\n]{100,}\s*-----END (?:[A-Z]+ )*PRIVATE KEY-----',
]
TARGETS = {'linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'}


def scan_bytes(data, name):
    for index, pattern in enumerate(PATTERNS):
        if re.search(pattern, data):
            raise ValueError(f'Potential credential/internal-host pattern {index + 1} in {name}; match redacted')


def inspect(filename, expected_version, wrapper=False):
    entries = {}
    with tarfile.open(filename, 'r:gz') as archive:
        for entry in archive:
            path = PurePosixPath(entry.name)
            if not path.parts or path.is_absolute() or '..' in path.parts or path.parts[0] != 'package':
                raise ValueError('Unsafe tarball path')
            if entry.isdir():
                continue
            if not entry.isfile() or entry.name in entries or entry.size > 64 << 20:
                raise ValueError('Unexpected tarball member')
            if any(part.startswith('.env') or part in {'.npmrc', '.netrc', 'credentials.json', '.aws', '.ssh'} for part in path.parts):
                raise ValueError('Credential-shaped filename in tarball')
            data = archive.extractfile(entry).read()
            scan_bytes(data, entry.name)
            entries[entry.name] = data
    package = json.loads(entries['package/package.json'])
    if package['name'] not in ({'yolostart'} if wrapper else {'yolostart', 'yolostart-native-release'}) or package['version'] != expected_version:
        raise ValueError('Packed package identity differs from release')
    if wrapper:
        allowed = {'package/package.json', 'package/README.md', 'package/THIRD_PARTY_NOTICES.txt',
                   'package/dist/cli.js', 'package/dist/launcher.js', 'package/dist/release-url.mjs'}
        if set(entries) != allowed or sum(map(len, entries.values())) > 256 << 10:
            raise ValueError('Bootstrap must contain only the small explicit file allowlist')
        if package.get('dependencies') or any(k in package.get('scripts', {}) for k in ('preinstall', 'install', 'postinstall')):
            raise ValueError('Bootstrap must install offline without dependencies or lifecycle downloads')
        # Refuse stale/unbuilt JS even if package.json was bumped independently.
        pins = re.findall(rb'^const PINNED_RELEASE = (.+);$', entries['package/dist/launcher.js'], re.M)
        if len(pins) != 1:
            raise ValueError('Bootstrap has no unique embedded native pin')
        pin = json.loads(pins[0])
        if pin.get('version') != expected_version or set(pin.get('files', {})) != TARGETS:
            raise ValueError('Bootstrap pin must match its package version and all four targets')
        for target, entry in pin['files'].items():
            if (entry.get('file') != f'yolostart-{target}.gz'
                    or not re.fullmatch(r'[a-f0-9]{64}', entry.get('sha256', ''))
                    or not re.fullmatch(r'[a-f0-9]{64}', entry.get('executableSha256', ''))):
                raise ValueError('Invalid embedded native digest')
        return hashlib.sha256(Path(filename).read_bytes()).hexdigest()
    prefix = f'package/dist/native/{expected_version}/'
    manifest = json.loads(entries[prefix + 'manifest.json'])
    if manifest['version'] != expected_version or set(manifest['files']) != TARGETS:
        raise ValueError('Exactly four native targets are required')
    expected_gzip = set()
    for target, record in manifest['files'].items():
        name = f'yolostart-{target}.gz'
        if record['file'] != name:
            raise ValueError('Invalid native filename')
        expected_gzip.add(prefix + name)
        compressed = entries[prefix + name]
        if hashlib.sha256(compressed).hexdigest() != record['sha256']:
            raise ValueError('Compressed executable checksum mismatch')
        with gzip.GzipFile(fileobj=io.BytesIO(compressed)) as executable:
            raw = executable.read((64 << 20) + 1)
        if len(raw) > 64 << 20 or hashlib.sha256(raw).hexdigest() != record['executableSha256']:
            raise ValueError('Executable checksum/size mismatch')
        scan_bytes(raw, name + ' (decompressed)')
    if package['name'] == 'yolostart-native-release':
        allowed = expected_gzip | {'package/package.json', prefix + 'manifest.json',
                                  prefix + 'SHA256SUMS', prefix + 'THIRD_PARTY_NOTICES.txt'}
        if set(entries) != allowed or package.get('private') is not True:
            raise ValueError('Native release must contain only native assets and private identity')
    if {name for name in entries if name.endswith('.gz')} != expected_gzip:
        raise ValueError('Stale or extra compressed artifacts in npm package')
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


if __name__ == '__main__':
    try:
        digest = inspect(sys.argv[1], sys.argv[2], '--wrapper' in sys.argv[3:])
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write(f'sha256={digest}\n')
        print('Exact bootstrap tarball passed credential-pattern and shape checks' if '--wrapper' in sys.argv[3:] else 'Exact native archive and all four executables passed credential-pattern and checksum checks')
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        print(f'Release scan failed: {error}', file=sys.stderr)
        sys.exit(1)
