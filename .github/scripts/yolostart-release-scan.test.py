import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('scan', Path(__file__).with_name('yolostart-release-scan.py'))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


class ScanTest(unittest.TestCase):
    def artifact(self, path, payload=b'native executable', corrupt=False, extra=False):
        prefix = 'package/dist/native/1.0.0/'
        entries = {'package/package.json': json.dumps({'name': 'yolostart', 'version': '1.0.0'}).encode()}
        manifest = {'version': '1.0.0', 'files': {}}
        for target in scan.TARGETS:
            compressed = gzip.compress(payload)
            name = f'yolostart-{target}.gz'
            entries[prefix + name] = compressed
            manifest['files'][target] = dict(file=name, sha256=hashlib.sha256(compressed).hexdigest(), executableSha256='0' * 64 if corrupt else hashlib.sha256(payload).hexdigest())
        entries[prefix + 'manifest.json'] = json.dumps(manifest).encode()
        if extra:
            entries['package/dist/native/old/stale.gz'] = gzip.compress(b'old')
        with tarfile.open(path, 'w:gz') as archive:
            for name, content in entries.items():
                entry = tarfile.TarInfo(name)
                entry.size = len(content)
                archive.addfile(entry, io.BytesIO(content))

    def test_exact_four_binary_checksums(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'package.tgz'
            self.artifact(filename)
            self.assertEqual(scan.inspect(filename, '1.0.0'), hashlib.sha256(filename.read_bytes()).hexdigest())
            self.artifact(filename, corrupt=True)
            with self.assertRaisesRegex(ValueError, 'checksum'):
                scan.inspect(filename, '1.0.0')
            self.artifact(filename, extra=True)
            with self.assertRaisesRegex(ValueError, 'extra compressed'):
                scan.inspect(filename, '1.0.0')

    def test_secret_in_compressed_binary_is_detected_and_redacted(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'package.tgz'
            credential = b'ghp_' + b'A' * 36
            self.artifact(filename, payload=b'prefix\x00' + credential + b'\x00suffix')
            with self.assertRaisesRegex(ValueError, 'decompressed') as caught:
                scan.inspect(filename, '1.0.0')
            self.assertNotIn(credential.decode(), str(caught.exception))

    def test_thin_bootstrap_shape_and_install_hooks(self):
        with tempfile.TemporaryDirectory() as directory:
            filename = Path(directory) / 'bootstrap.tgz'
            pkg = {'name': 'yolostart', 'version': '1.0.0'}
            entries = {f'package/{name}': b'fixture' for name in
                       ('README.md', 'THIRD_PARTY_NOTICES.txt', 'dist/cli.js', 'dist/launcher.js', 'dist/release-url.mjs')}
            def pack():
                entries['package/package.json'] = json.dumps(pkg).encode()
                with tarfile.open(filename, 'w:gz') as archive:
                    for name, content in entries.items():
                        entry = tarfile.TarInfo(name)
                        entry.size = len(content)
                        archive.addfile(entry, io.BytesIO(content))
            pack()
            scan.inspect(filename, '1.0.0', wrapper=True)
            entries['package/dist/native/old/stale.gz'] = gzip.compress(b'stale')
            pack()
            with self.assertRaisesRegex(ValueError, 'allowlist'):
                scan.inspect(filename, '1.0.0', wrapper=True)
            del entries['package/dist/native/old/stale.gz']
            pkg['scripts'] = {'postinstall': 'fetch-native'}
            pack()
            with self.assertRaisesRegex(ValueError, 'lifecycle'):
                scan.inspect(filename, '1.0.0', wrapper=True)

    def test_pem_payload_not_go_parser_label(self):
        scan.scan_bytes(b'-----BEGIN PRIVATE KEY-----', 'Go parser constant')
        with self.assertRaisesRegex(ValueError, 'redacted'):
            scan.scan_bytes(b'-----BEGIN PRIVATE KEY-----\n' + b'A' * 128 + b'\n-----END PRIVATE KEY-----', 'fixture')


if __name__ == '__main__':
    unittest.main()
