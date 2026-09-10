import { mkdir, readFile, writeFile, cp, mkdtemp, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { restoreReleases, addRelease } from './releases.mjs';
const result = spawnSync("npm", ["run", "build"], {
  cwd: new URL("../packages/yolostart/", import.meta.url),
  stdio: "inherit",
});
if (result.error || result.status !== 0)
  throw new Error(
    "Native CLI build failed. Build machine requires Go and npm.",
  );
const script = await readFile(new URL("./install.sh", import.meta.url), "utf8");
const banner = script.match(/cat <<'BANNER'\n([\s\S]*?)\nBANNER\n/)?.[1];
if (!banner) throw Error('Installer banner missing');
const template = await readFile(new URL('./landing.html', import.meta.url), 'utf8');
if (template.split('<!-- INSTALL_BANNER -->').length !== 2) throw Error('Landing banner slot missing or duplicated');
const escapeHtml = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
const landing = template.replace('<!-- INSTALL_BANNER -->', () => escapeHtml(banner));
const {version} = JSON.parse(await readFile(new URL('../packages/yolostart/package.json', import.meta.url), 'utf8'));
await mkdir(new URL('./dist/',import.meta.url),{recursive:true});
const staging=await mkdtemp(fileURLToPath(new URL('./dist/release-build-',import.meta.url)));
try {
  const assets=staging+'/assets';
  const releases=assets+'/releases';
  const bootstrap=JSON.parse(await readFile(new URL('./releases.json',import.meta.url),'utf8'));
  const index=await restoreReleases(releases,bootstrap);
  // Pack a clean package tree: ignored historical local outputs must not alter
  // the bytes or bulk of a versioned npm tarball.
  const packageDir=staging+'/package';
  await mkdir(packageDir+'/dist/native/'+version,{recursive:true});
  for(const filename of ['package.json','README.md','THIRD_PARTY_NOTICES.txt','dist/cli.js','dist/launcher.js'])
    await cp(new URL('../packages/yolostart/'+filename,import.meta.url),packageDir+'/'+filename);
  await cp(new URL('../packages/yolostart/dist/native/'+version+'/',import.meta.url),packageDir+'/dist/native/'+version,{recursive:true});
  await writeFile(packageDir+'/dist/native/latest.txt',version+'\n');
  const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',staging],{cwd:packageDir,encoding:'utf8'});
  if(packed.error||packed.status!==0) throw Error('npm package build failed');
  await addRelease(index,staging+'/yolostart-'+version+'.tgz',version,releases);
  await rm(new URL('./dist/assets/',import.meta.url),{recursive:true,force:true});
  await rename(assets,new URL('./dist/assets/',import.meta.url));
} finally { await rm(staging,{recursive:true,force:true}); }
await writeFile(
  new URL('./dist/worker.mjs', import.meta.url),
  `// Generated from install.sh and landing.html; do not edit.
const script = ${JSON.stringify(script)};
const landing = ${JSON.stringify(landing)};
export default { fetch(request, env) {
  const url = new URL(request.url);
  const noStore = url.pathname === '/yolostart.tgz' || url.pathname === '/releases/latest.txt' || url.pathname === '/releases/index.json';
  if (url.pathname === '/yolostart.tgz') url.pathname = '/releases/${version}/yolostart-${version}.tgz';
  if (url.pathname.startsWith('/releases/')) {
    const response = env.ASSETS.fetch(new Request(url, request));
    if (!noStore) return response;
    return Promise.resolve(response).then(result => {
      const headers = new Headers(result.headers); headers.set('Cache-Control', 'no-store');
      return new Response(result.body, {status:result.status, headers});
    });
  }
  if (url.pathname !== '/' && url.pathname !== '/install.sh') return new Response('Not found', {status:404});
  const isBrowser = request.headers.get('sec-fetch-dest') === 'document'
    || (request.headers.get('accept') ?? '').includes('text/html');
  const html = url.pathname === '/' && !url.searchParams.has('raw') && isBrowser;
  return new Response(html ? landing : script, {headers:{
    'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8',
    'Vary': 'Accept, Sec-Fetch-Dest',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }});
} };
`,
);
