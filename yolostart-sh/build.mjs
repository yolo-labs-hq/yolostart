import { mkdir, readFile, writeFile, cp } from "node:fs/promises";
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
await writeFile(
  new URL("./dist/worker.mjs", import.meta.url),
  `// Generated from install.sh; do not edit.\nconst script = ${JSON.stringify(script)};\nexport default { fetch(request, env) { const path = new URL(request.url).pathname; if (path.startsWith('/releases/')) return env.ASSETS.fetch(request); if (path !== '/' && path !== '/install.sh') return new Response('Not found', {status:404}); return new Response(script, {headers:{'Content-Type':'text/plain; charset=utf-8','X-Content-Type-Options':'nosniff'}}); } };\n`,
);
