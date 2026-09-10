import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
import {restoreReleases,addRelease,digest,releaseOrigin} from '../releases.mjs';
async function fixture(t,version,contents='binary') {
 const dir=await mkdtemp(join(tmpdir(),'yolostart-archive-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const native=join(dir,'package/dist/native',version);await mkdir(native,{recursive:true});
 await writeFile(join(dir,'package/package.json'),JSON.stringify({name:'yolostart',version}));
 const manifest={version,files:{}};
 for(const target of ['linux-amd64','linux-arm64','darwin-amd64','darwin-arm64']){
  const file=`yolostart-${target}.gz`;const binary=gzipSync(contents);
  manifest.files[target]={file,sha256:digest(binary),executableSha256:digest(Buffer.from(contents))};
  await writeFile(join(native,file),binary);
 }
 await writeFile(join(native,'manifest.json'),JSON.stringify(manifest));
 await writeFile(join(native,'SHA256SUMS'),Object.values(manifest.files).map(f=>`${f.sha256}  ${f.file}\n`).join(''));
 await writeFile(join(native,'THIRD_PARTY_NOTICES.txt'),'license');
 const archive=join(dir,`yolostart-${version}.tgz`);
 const tar=spawnSync('tar',['-czf',archive,'-C',dir,'package']);assert.equal(tar.status,0);
 const data=await readFile(archive);
 return {dir,archive,data,record:{version,sha256:digest(data),bytes:data.length}};
}
function remote(index,latest,archives) {
 return async url=>{
  const path=String(url).replace(releaseOrigin,'');
  if(path==='index.json')return index?Response.json(index):new Response('',{status:404});
  if(path==='latest.txt')return new Response(latest+'\n');
  return archives[path]?new Response(archives[path]):new Response('',{status:404});
 };
}
test('a clean second build restores every pinned archive and all native assets',async t=>{
 const old=await fixture(t,'1.0.0');const next=await fixture(t,'1.1.0');
 const bootstrap={schemaVersion:1,releases:[old.record]};
 const restored=join(old.dir,'first-clean-build');
 const index=await restoreReleases(restored,bootstrap,remote(null,'1.0.0',{'1.0.0/yolostart-1.0.0.tgz':old.data}));
 await addRelease(index,next.archive,'1.1.0',restored);
 assert.equal(index.releases.length,2);
 const second=join(old.dir,'second-clean-build');
 await restoreReleases(second,bootstrap,remote(index,'1.1.0',{'1.0.0/yolostart-1.0.0.tgz':old.data,'1.1.0/yolostart-1.1.0.tgz':next.data}));
 for(const release of [old,next]){
  assert.equal(digest(await readFile(join(second,release.record.version,`yolostart-${release.record.version}.tgz`))),release.record.sha256);
  for(const target of ['linux-amd64','linux-arm64','darwin-amd64','darwin-arm64'])assert.ok((await readFile(join(second,release.record.version,`yolostart-${target}.gz`))).length);
 }
});
test('missing or changed release data stops the build instead of losing pins',async t=>{
 const old=await fixture(t,'1.0.0');const bootstrap={schemaVersion:1,releases:[old.record]};
 await assert.rejects(restoreReleases(join(old.dir,'missing'),bootstrap,remote(null,'1.0.0',{})),/restoration failed/);
 await assert.rejects(restoreReleases(join(old.dir,'unknown'),bootstrap,remote(null,'2.0.0',{})),/missing from archive index/);
 await assert.rejects(restoreReleases(join(old.dir,'corrupt'),bootstrap,remote(bootstrap,'1.0.0',{'1.0.0/yolostart-1.0.0.tgz':Buffer.from('changed')})),/checksum\/size mismatch/);
 const changed=structuredClone(bootstrap);changed.releases[0].sha256='0'.repeat(64);
 await assert.rejects(restoreReleases(join(old.dir,'mutated-index'),bootstrap,remote(changed,'1.0.0',{})),/changed a committed pin/);
 const different=await fixture(t,'1.0.0','different');
 await assert.rejects(addRelease(bootstrap,different.archive,'1.0.0',join(old.dir,'repack')),/immutable/);
});
