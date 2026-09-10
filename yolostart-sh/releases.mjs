import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

export const releaseOrigin = 'https://yolostart-sh.yolo.host/releases/';
const targets = ['linux-amd64', 'linux-arm64', 'darwin-amd64', 'darwin-arm64'];
export const digest = data => createHash('sha256').update(data).digest('hex');
const versionPattern = /^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/;
export function validateIndex(index) {
  if (index?.schemaVersion !== 1 || !Array.isArray(index.releases) || !index.releases.length || index.releases.length > 1000)
    throw Error('Invalid release index');
  const seen = new Set();
  for (const item of index.releases) {
    if (!versionPattern.test(item.version) || !/^[a-f0-9]{64}$/.test(item.sha256) || !Number.isSafeInteger(item.bytes) || item.bytes <= 0 || item.bytes > 64 * 1024 * 1024 || seen.has(item.version))
      throw Error('Invalid release record');
    seen.add(item.version);
  }
  return index;
}
async function download(url, limit, fetchImpl) {
  const response = await fetchImpl(url, {redirect:'error', cache:'no-store', signal:AbortSignal.timeout(60000)});
  if (!response.ok) { const error = Error(`Release restoration failed (HTTP ${response.status})`); error.status = response.status; throw error; }
  const chunks=[];let size=0;
  for await (const chunk of response.body) {
    size+=chunk.length;
    if(size>limit) { throw Error('Release response exceeds size limit'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
function member(archive, path) {
  const result=spawnSync('tar',['-xzOf',archive,path],{maxBuffer:64*1024*1024,timeout:30000});
  if(result.error || result.status!==0) throw Error(`Release archive lacks ${path}`);
  return result.stdout;
}
export async function installRelease(record, data, target) {
  if(data.length!==record.bytes || digest(data)!==record.sha256) throw Error(`Release ${record.version} checksum/size mismatch`);
  const dir=join(target,record.version);
  await mkdir(dir,{recursive:true});
  const archive=join(dir,`yolostart-${record.version}.tgz`);
  await writeFile(archive,data);
  const pkg=JSON.parse(member(archive,'package/package.json'));
  if(pkg.name!=='yolostart'||pkg.version!==record.version) throw Error('Release package identity mismatch');
  const prefix=`package/dist/native/${record.version}/`;
  const metadata=member(archive,prefix+'manifest.json');
  const manifest=JSON.parse(metadata);
  if(manifest.version!==record.version || Object.keys(manifest.files).sort().join(',')!==[...targets].sort().join(',')) throw Error('Release lacks four native targets');
  for(const targetName of targets){
    const filename=`yolostart-${targetName}.gz`;
    const entry=manifest.files[targetName];
    if(entry.file!==filename) throw Error('Invalid native filename');
    const binary=member(archive,prefix+filename);
    if(digest(binary)!==entry.sha256) throw Error('Native release checksum mismatch');
    await writeFile(join(dir,filename),binary);
  }
  await writeFile(join(dir,'manifest.json'),metadata);
  for(const filename of ['SHA256SUMS','THIRD_PARTY_NOTICES.txt']) await writeFile(join(dir,filename),member(archive,prefix+filename));
}

// The active production asset store survives preview GC. Carry its complete
// immutable inventory forward before replacing the deployment. Never silently
// continue with only local build output when the archive is unavailable.
export async function restoreReleases(target, bootstrap, fetchImpl=fetch) {
  validateIndex(bootstrap);
  let index;
  try { index=validateIndex(JSON.parse(await download(releaseOrigin+'index.json',1024*1024,fetchImpl))); }
  catch(error) { if(error.status!==404) throw error; index=structuredClone(bootstrap); }
  const latest=(await download(releaseOrigin+'latest.txt',128,fetchImpl)).toString().trim();
  if(!index.releases.some(item=>item.version===latest)) throw Error('Live release is missing from archive index; refusing to drop versions');
  for(const pinned of bootstrap.releases){
    const live=index.releases.find(item=>item.version===pinned.version);
    if(!live || live.sha256!==pinned.sha256 || live.bytes!==pinned.bytes) throw Error('Live release inventory changed a committed pin');
  }
  for(const item of index.releases){
    const data=await download(`${releaseOrigin}${item.version}/yolostart-${item.version}.tgz`,item.bytes,fetchImpl);
    await installRelease(item,data,target);
  }
  return index;
}
export async function addRelease(index, archive, version, target) {
  if(!versionPattern.test(version)) throw Error('Invalid new release version');
  const data=await readFile(archive);
  const record={version,sha256:digest(data),bytes:data.length};
  const existing=index.releases.find(item=>item.version===version);
  if(existing && (existing.sha256!==record.sha256 || existing.bytes!==record.bytes)) throw Error('Hosted version is immutable; bump the CLI version before rebuilding it');
  if(!existing){ await installRelease(record,data,target);index.releases.push(record); }
  validateIndex(index);
  await writeFile(join(target,'index.json'),JSON.stringify(index,null,2)+'\n');
  await writeFile(join(target,'latest.txt'),version+'\n');
}
