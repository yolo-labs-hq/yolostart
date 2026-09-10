import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {compactReleases} from '../distribution.mjs';
import {digest,restoreReleases} from '../releases.mjs';

async function fixture(run) {
 const dir=await mkdtemp(join(tmpdir(),'yolostart-distribution-'));
 try {
  const remote=new Map();
  const version='1.0.0';await mkdir(join(dir,version));
  for(const name of [`yolostart-${version}.tgz`,...['linux-amd64','linux-arm64','darwin-amd64','darwin-arm64'].map(t=>`yolostart-${t}.gz`)]) {
   const data=Buffer.from(name.repeat(4));
   await writeFile(join(dir,version,name),data);remote.set(`https://dl.yolo.studio/yolostart/${version}/${name}`,data);
  }
  await writeFile(join(dir,version,'SHA256SUMS'),'retained metadata');
  const fetchImpl=async(url,options)=>{
   assert.equal(options.redirect,'error');assert.match(options.headers['User-Agent'],/^yolostart-release/);
   return remote.has(url)?new Response(remote.get(url)):new Response('missing',{status:404});
  };
  await run(dir,{releases:[{version}]},remote,fetchImpl);
 } finally {await rm(dir,{recursive:true,force:true});}
}

test('verified public payloads retain Host URLs and exact bytes while small metadata stays local',()=>fixture(async(dir,index,remote,fetchImpl)=>{
 const downloads=await compactReleases(index,dir,30,fetchImpl);
 assert.equal(Object.keys(downloads).length,5);
 assert.equal(await readFile(join(dir,'1.0.0','SHA256SUMS'),'utf8'),'retained metadata');
 for(const [path,record] of Object.entries(downloads)){
  assert.ok(path.startsWith('/releases/1.0.0/'));
  await assert.rejects(readFile(join(dir,path.slice('/releases/'.length))),{code:'ENOENT'});
  assert.equal(record.bytes,remote.get(record.url).length);
  assert.equal(record.sha256,digest(remote.get(record.url)));
 }
}));

test('under-cap releases need no downloads dependency',()=>fixture(async(dir,index)=>{
 assert.deepEqual(await compactReleases(index,dir,10000,()=>{throw Error('unexpected fetch');}),{});
}));

test('absent or changed public copies never discard pins',async()=>{
 for(const missing of [true,false]) await fixture(async(dir,index,remote,fetchImpl)=>{
  const key=[...remote.keys()][0];
  if(missing)remote.delete(key);else remote.set(key,Buffer.from('wrong bytes'));
  await assert.rejects(compactReleases(index,dir,30,fetchImpl),missing?/exceed capacity/:/bytes differ/);
  assert.ok((await readFile(join(dir,'1.0.0','yolostart-1.0.0.tgz'))).length>0);
 });
});

test('restoration refuses redirects except the exact artifact on the downloads origin',async()=>{
 const bootstrap={schemaVersion:1,releases:[{version:'1.0.0',sha256:'a'.repeat(64),bytes:10}]};
 for(const location of ['https://evil.test/file.tgz','https://dl.yolo.studio/yolostart/2.0.0/yolostart-2.0.0.tgz']){
  const dir=await mkdtemp(join(tmpdir(),'yolostart-redirect-'));
  try {
   const fetchImpl=async url=>url.endsWith('index.json')?Response.json(bootstrap):url.endsWith('latest.txt')?new Response('1.0.0'):new Response(null,{status:307,headers:{location}});
   await assert.rejects(restoreReleases(dir,bootstrap,fetchImpl),/Untrusted release redirect/);
  } finally {await rm(dir,{recursive:true,force:true});}
 }
});
