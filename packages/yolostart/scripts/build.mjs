import {spawnSync} from 'node:child_process';
import {rm, mkdir, readdir, readFile, writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const root = new URL('../',import.meta.url);
const {version} = JSON.parse(await readFile(new URL('package.json',root),'utf8'));
const native = new URL(`dist/native/${version}/`,root);
// Compilation itself needs no Go. Release workflows build natives first; never
// fetch mutable TLS metadata to manufacture the npm package's trust anchor.
let manifest;
try {manifest=JSON.parse(await readFile(new URL('manifest.json',native),'utf8'));}
catch {throw Error('Build native artifacts first: npm run build:native');}
const targets=['darwin-amd64','darwin-arm64','linux-amd64','linux-arm64'];
if(manifest.version!==version || Object.keys(manifest.files ?? {}).sort().join()!==targets.join())
  throw Error('Pinning requires exactly four native targets for the package version');
const digest=data=>createHash('sha256').update(data).digest('hex');
for(const target of targets) {
  const entry=manifest.files[target];
  if(entry.file!==`yolostart-${target}.gz`) throw Error('Invalid native filename');
  const compressed=await readFile(new URL(entry.file,native));
  if(digest(compressed)!==entry.sha256 || digest(gunzipSync(compressed,{maxOutputLength:64*1024*1024}))!==entry.executableSha256)
    throw Error('Native artifact does not match the embedded release digests');
}
const dist=new URL('dist/',root);
await mkdir(dist,{recursive:true});
for(const file of await readdir(dist)) if(/\.(?:js|mjs|map)$/.test(file)) await rm(new URL(file,dist));
const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{cwd:root,stdio:'inherit'});
if(result.error || result.status!==0) throw Error('Bootstrap build failed');
const launcher=new URL('launcher.js',dist);
const source=await readFile(launcher,'utf8');
const sentinel='const PINNED_RELEASE = undefined;';
if(source.split(sentinel).length!==2) throw Error('Missing or ambiguous native pin build sentinel');
await writeFile(launcher,source.replace(sentinel,()=>`const PINNED_RELEASE = ${JSON.stringify({version,files:manifest.files})};`));
