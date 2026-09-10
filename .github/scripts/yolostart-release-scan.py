"""Inspect the exact npm tarball and every embedded native executable.

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


def inspect(filename, expected_version):
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
    if package['name'] != 'yolostart' or package['version'] != expected_version:
        raise ValueError('Packed package identity differs from release')
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
    if {name for name in entries if name.endswith('.gz')} != expected_gzip:
        raise ValueError('Stale or extra compressed artifacts in npm package')
    return hashlib.sha256(Path(filename).read_bytes()).hexdigest()


if __name__ == '__main__':
    try:
        digest = inspect(sys.argv[1], sys.argv[2])
        if os.environ.get('GITHUB_OUTPUT'):
            with open(os.environ['GITHUB_OUTPUT'], 'a') as output:
                output.write(f'sha256={digest}\n')
        print('Exact tarball and all four decompressed executables passed credential-pattern and checksum checks')
    except (ValueError, KeyError, OSError, tarfile.TarError) as error:
        print(f'Release scan failed: {error}', file=sys.stderr)
        sys.exit(1)
