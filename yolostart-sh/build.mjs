import { mkdir, readFile, writeFile, mkdtemp, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { restoreReleases, addRelease } from './releases.mjs';
import { compactReleases } from './distribution.mjs';
const result = spawnSync("npm", ["run", "pack:native"], {
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
const svg = await readFile(new URL('./icons/octopus.svg', import.meta.url), 'utf8');
const landing = template.replace('<!-- INSTALL_BANNER -->', () => escapeHtml(banner))
  .replace('<!-- ICON_SVG -->', () => 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'));
const icons = {};
for (const [path, type] of [['favicon.ico', 'image/x-icon'], ['apple-touch-icon.png', 'image/png']]) {
  icons['/' + path] = {type, bytes: (await readFile(new URL('./icons/' + path, import.meta.url))).toString('base64')};
}
const {version} = JSON.parse(await readFile(new URL('../packages/yolostart/package.json', import.meta.url), 'utf8'));
const {version: bootstrapVersion} = JSON.parse(await readFile(new URL('../packages/yolostart/package.json', import.meta.url), 'utf8'));
const bootstrapBuild=spawnSync('npm',['run','build'],{cwd:new URL('../packages/yolostart/',import.meta.url),stdio:'inherit'});
if(bootstrapBuild.error || bootstrapBuild.status!==0) throw Error('Bootstrap build failed');
await mkdir(new URL('./dist/',import.meta.url),{recursive:true});
const staging=await mkdtemp(fileURLToPath(new URL('./dist/release-build-',import.meta.url)));
let downloads;
try {
  const assets=staging+'/assets';
  const releases=assets+'/releases';
  const bootstrap=JSON.parse(await readFile(new URL('./releases.json',import.meta.url),'utf8'));
  const index=await restoreReleases(releases,bootstrap);
  await addRelease(index,fileURLToPath(new URL(`../packages/yolostart/dist/releases/yolostart-${version}.tgz`,import.meta.url)),version,releases);
  // npm pack has an explicit file allowlist: native archives never enter it.
  await mkdir(assets+'/bootstrap',{recursive:true});
  const packed=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',assets+'/bootstrap'],{cwd:new URL('../packages/yolostart/',import.meta.url),encoding:'utf8'});
  if(packed.error||packed.status!==0) throw Error('Bootstrap package build failed');
  downloads=await compactReleases(index,releases);
  await rm(new URL('./dist/assets/',import.meta.url),{recursive:true,force:true});
  await rename(assets,new URL('./dist/assets/',import.meta.url));
} finally { await rm(staging,{recursive:true,force:true}); }
await writeFile(
  new URL('./dist/worker.mjs', import.meta.url),
  `// Generated from install.sh and landing.html; do not edit.
const script = ${JSON.stringify(script)};
const landing = ${JSON.stringify(landing)};
const downloads = ${JSON.stringify(downloads)};
const icons = ${JSON.stringify(icons)};
export default { fetch(request, env) {
  const url = new URL(request.url);
  if (icons[url.pathname]) {
    const icon = icons[url.pathname];
    return new Response(Uint8Array.from(atob(icon.bytes), c => c.charCodeAt(0)), {headers:{'Content-Type':icon.type, 'Cache-Control':'public, max-age=86400', 'X-Content-Type-Options':'nosniff'}});
  }
  const noStore = url.pathname === '/yolostart.tgz' || url.pathname === '/releases/latest.txt' || url.pathname === '/releases/index.json';
  if (url.pathname === '/yolostart.tgz') url.pathname = '/bootstrap/yolostart-${bootstrapVersion}.tgz';
  if (url.pathname.startsWith('/releases/') || url.pathname.startsWith('/bootstrap/')) {
    const response = downloads[url.pathname] ? new Response(null, {status:307, headers:{Location:downloads[url.pathname].url, 'Cache-Control':'public, max-age=31536000, immutable'}}) : env.ASSETS.fetch(new Request(url, request));
    if (!noStore) return response;
    return Promise.resolve(response).then(result => {
      const headers = new Headers(result.headers); headers.set('Cache-Control', 'no-store');
      return new Response(result.body, {status:result.status, headers});
    });
  }
  if (url.pathname === '/api/waitlist') {
    const json = (body, status) => new Response(JSON.stringify(body), {status, headers:{'Content-Type':'application/json','Cache-Control':'no-store'}});
    if (request.method !== 'POST') return json({error:'Method not allowed'}, 405);
    return (async () => {
      let email = '';
      try {
        const body = await request.json();
        if (body && typeof body.email === 'string') email = body.email.trim();
      } catch { email = ''; }
      // Cheap shape guard only; the upstream validates properly. Deliberately
      // regex-free — this source is emitted through a template literal, where a
      // stray backslash escape silently changes the pattern.
      const at = email.indexOf('@'), dot = email.lastIndexOf('.');
      const shaped = at > 0 && dot > at + 1 && dot < email.length - 1
        && email.length <= 254 && !email.includes(' ');
      if (!shaped) return json({error:'Enter a valid email address.'}, 400);
      try {
        // product and source are fixed HERE, never read from the request: a
        // browser must not be able to write itself into another product's list.
        const upstream = await fetch('https://waitlist.yololabs.ai/api/waitlist', {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body: JSON.stringify({email, product:'yolo-studio', source:'yolostart'}),
        });
        if (upstream.status === 409) return json({ok:true, already:true}, 200);
        if (!upstream.ok) return json({error:'Could not reach the list just now. Try again shortly.'}, 502);
        return json({ok:true}, 200);
      } catch {
        // Never surface the upstream body or error: it is not ours to leak.
        return json({error:'Could not reach the list just now. Try again shortly.'}, 502);
      }
    })();
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
