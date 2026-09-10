import {spawnSync} from 'node:child_process';
import {rm, mkdir, readdir} from 'node:fs/promises';
const dist = new URL('../dist/',import.meta.url);
await mkdir(dist,{recursive:true});
for (const file of await readdir(dist)) if (/\.(?:js|mjs|map)$/.test(file)) await rm(new URL(file,dist));
const result=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','tsconfig.json'],{cwd:new URL('../',import.meta.url),stdio:'inherit'});
if(result.error || result.status !== 0) throw Error('Bootstrap build failed');
