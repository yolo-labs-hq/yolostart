import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec = promisify(execFile);
test('exact npm tarball is small, has no natives/hooks, and installs and loads offline',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yolostart-npm-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const root=fileURLToPath(new URL('../',import.meta.url));
  const packed=JSON.parse((await exec('npm',['pack','--ignore-scripts','--json','--pack-destination',dir],{cwd:root})).stdout)[0];
  assert.ok(packed.size < 64*1024,`unexpected package size: ${packed.size}`);
  assert.deepEqual(packed.files.map((f:{path:string})=>f.path).sort(),['README.md','THIRD_PARTY_NOTICES.txt','dist/cli.js','dist/launcher.js','dist/release-url.mjs','package.json']);
  await exec('python3',[fileURLToPath(new URL('../../../.github/scripts/yolostart-release-scan.py',import.meta.url)),path.join(dir,packed.filename),packed.version,'--wrapper']);
  await exec('npm',['install','--offline','--ignore-scripts','--no-audit','--no-fund','--cache',path.join(dir,'empty-cache'),path.join(dir,packed.filename)],{cwd:dir});
  const pkg=JSON.parse(await readFile(path.join(dir,'node_modules/yolostart/package.json'),'utf8'));
  assert.deepEqual(pkg.dependencies,{});
  for(const hook of ['preinstall','install','postinstall']) assert.equal(pkg.scripts[hook],undefined);
  await exec(process.execPath,['--input-type=module','-e','const m=await import("./node_modules/yolostart/dist/launcher.js"); if(typeof m.launch!=="function") throw Error("load failed");'],{cwd:dir});
});

test('embedding fails closed for missing native targets or tampered artifact bytes',async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'yolostart-pin-build-'));
  t.after(()=>rm(dir,{recursive:true,force:true}));
  const {mkdir,writeFile}=await import('node:fs/promises');
  const {gzipSync}=await import('node:zlib');
  const {createHash}=await import('node:crypto');
  const hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
  await mkdir(path.join(dir,'scripts'));
  const native=path.join(dir,'dist/native/9.8.7');
  await mkdir(native,{recursive:true});
  await writeFile(path.join(dir,'package.json'),JSON.stringify({type:'module',version:'9.8.7'}));
  await writeFile(path.join(dir,'scripts/build.mjs'),await readFile(new URL('../scripts/build.mjs',import.meta.url)));
  const manifest:{version:string;files:Record<string,{file:string;sha256:string;executableSha256:string}>}={version:'9.8.7',files:{}};
  await writeFile(path.join(native,'manifest.json'),JSON.stringify(manifest));
  await assert.rejects(exec(process.execPath,['scripts/build.mjs'],{cwd:dir}),/exactly four native targets/);
  const raw=Buffer.from('fixture'),compressed=gzipSync(raw);
  for(const target of ['darwin-amd64','darwin-arm64','linux-amd64','linux-arm64']) {
    const file=`yolostart-${target}.gz`;
    manifest.files[target]={file,sha256:hash(compressed),executableSha256:hash(raw)};
    await writeFile(path.join(native,file),compressed);
  }
  await writeFile(path.join(native,'manifest.json'),JSON.stringify(manifest));
  await writeFile(path.join(native,'yolostart-darwin-arm64.gz'),'tampered');
  await assert.rejects(exec(process.execPath,['scripts/build.mjs'],{cwd:dir}),/does not match the embedded release digests/);
});
