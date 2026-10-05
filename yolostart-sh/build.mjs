import { mkdir, readFile, mkdtemp, rm, rename } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { restoreReleases, addRelease } from './releases.mjs';
import { buildWorker } from './build-worker.mjs';
import { compactReleases } from './distribution.mjs';
// Google Analytics tag for the landing page, from config/analytics.json (see
// scripts/analytics/). The public mirror has no scripts/analytics: no tag there.
// GA_MEASUREMENT_ID overrides the file; GA_MEASUREMENT_ID=off builds without it.
async function analyticsHtml(site) {
  if (process.env.GA_MEASUREMENT_ID === 'off') return '';
  let mod;
  try { mod = await import('../scripts/analytics/head-html.mjs'); } catch { return ''; }
  return mod.analyticsHeadHtml(site);
}
const result = spawnSync("npm", ["run", "pack:native"], {
  cwd: new URL("../packages/yolostart/", import.meta.url),
  stdio: "inherit",
});
if (result.error || result.status !== 0)
  throw new Error(
    "Native CLI build failed. Build machine requires Go and npm.",
  );
const {version} = JSON.parse(await readFile(new URL('../packages/yolostart/package.json', import.meta.url), 'utf8'));
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
await buildWorker(downloads, new URL('./dist/', import.meta.url), {analyticsHtml: await analyticsHtml('yolostart')});
