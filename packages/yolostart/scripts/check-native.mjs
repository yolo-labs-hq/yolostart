// Run only after the archive scanner has validated paths, entry types and hashes.
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
const [archive,version] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw Error('Invalid native version');
const checked = spawnSync('python3',[new URL('../../../.github/scripts/yolostart-release-scan.py',import.meta.url).pathname,archive,version],{stdio:'inherit'});
if (checked.status !== 0) process.exit(1);
const target = `${process.platform}-${process.arch === 'x64' ? 'amd64' : process.arch}`;
const dir = mkdtempSync(path.join(tmpdir(),'yolostart-native-check-'));
try {
  const base = `package/dist/native/${version}/`;
  const extract = name => {
    const result = spawnSync('tar',['-xOzf',archive,base+name],{maxBuffer:64*1024*1024});
    if (result.status !== 0) throw Error(`Cannot read native archive ${name}`);
    return result.stdout;
  };
  const manifest = JSON.parse(extract('manifest.json'));
  const entry = manifest.files[target];
  const binary = gunzipSync(extract(entry.file),{maxOutputLength:64*1024*1024});
  if(createHash('sha256').update(binary).digest('hex')!==entry.executableSha256) throw Error('Native checksum mismatch');
  const executable = path.join(dir,'yolostart'); writeFileSync(executable,binary,{mode:0o700});
  const run = spawnSync(executable,['--version'],{encoding:'utf8',timeout:10000});
  if(run.status!==0 || run.stdout.trim()!==version) throw Error('Native version check failed');
  console.log(`Native archive verified: ${version} (${target})`);
} finally {rmSync(dir,{recursive:true,force:true});}
