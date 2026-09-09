import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const result = spawnSync("npm", ["run", "build"], {
  cwd: new URL("../packages/yolostart/", import.meta.url),
  stdio: "inherit",
});
if (result.error || result.status !== 0)
  throw new Error(
    "Native CLI build failed. Build machine requires Go and npm.",
  );
const script = await readFile(new URL("./install.sh", import.meta.url), "utf8");
await mkdir(new URL("./dist/assets/releases/", import.meta.url), {
  recursive: true,
});
await cp(
  new URL("../packages/yolostart/dist/native/", import.meta.url),
  new URL("./dist/assets/releases/", import.meta.url),
  { recursive: true },
);
const {version} = JSON.parse(await readFile(new URL('../packages/yolostart/package.json', import.meta.url), 'utf8'));
const packed = spawnSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', fileURLToPath(new URL(`./dist/assets/releases/${version}/`, import.meta.url))], {
  cwd: new URL('../packages/yolostart/', import.meta.url), encoding: 'utf8',
});
if (packed.error || packed.status !== 0) throw new Error(`npm package build failed: ${packed.stderr}`);
await writeFile(
  new URL('./dist/worker.mjs', import.meta.url),
  `// Generated from install.sh; do not edit.
const script = ${JSON.stringify(script)};
export default { fetch(request, env) {
  const url = new URL(request.url);
  const noStore = url.pathname === '/yolostart.tgz' || url.pathname === '/releases/latest.txt';
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
  return new Response(script, {headers:{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'}});
} };
`,
);
