import {readFile, readdir, stat, unlink} from 'node:fs/promises';
import {join} from 'node:path';
import {digest} from './releases.mjs';

async function treeBytes(dir) {
  let bytes=0;
  for(const entry of await readdir(dir,{withFileTypes:true})) {
    const path=join(dir,entry.name);
    bytes+=entry.isDirectory()?await treeBytes(path):(await stat(path)).size;
  }
  return bytes;
}

// Leave room for Worker code below Host's 50 MiB cap. Use existing public
// artifacts only after byte verification; no storage credentials or writes.
export async function compactReleases(index, dir, limit=49*1024*1024, fetchImpl=fetch) {
  let bytes=await treeBytes(dir);
  const downloads={};
  for(const {version} of index.releases) {
    if(bytes<=limit) break;
    const names=[`yolostart-${version}.tgz`, ...['linux-amd64','linux-arm64','darwin-amd64','darwin-arm64'].map(t=>`yolostart-${t}.gz`)];
    const verified=[];
    for(const name of names) {
      const path=join(dir,version,name);
      const local=await readFile(path);
      const url=`https://dl.yolo.studio/yolostart/${version}/${name}`;
      const response=await fetchImpl(url,{redirect:'error',headers:{'User-Agent':'yolostart-release/1 (+https://yolo.studio)'},signal:AbortSignal.timeout(60000)});
      // Legacy releases can predate the downloads bucket. Keep those on Host.
      if(response.status===404 && name===names[0]) break;
      if(!response.ok || !response.body) throw Error(`Cannot verify public release ${version}/${name}`);
      let size=0;const chunks=[];
      for await(const chunk of response.body) {
        size+=chunk.length;
        if(size>local.length) throw Error(`Public release size mismatch: ${version}/${name}`);
        chunks.push(chunk);
      }
      if(!Buffer.concat(chunks).equals(local)) throw Error(`Public release bytes differ: ${version}/${name}`);
      verified.push({path,key:`/releases/${version}/${name}`,record:{url,bytes:local.length,sha256:digest(local)}});
    }
    if(verified.length!==names.length) continue;
    for(const {path,key,record} of verified){downloads[key]=record;await unlink(path);bytes-=record.bytes;}
  }
  if(bytes>limit) throw Error('Host release assets exceed capacity; publish matching native downloads first. No pins were discarded.');
  return downloads;
}
