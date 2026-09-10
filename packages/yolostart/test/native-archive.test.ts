import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,chmod,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createNativeArchive} from '../scripts/native-archive.mjs';

test('native archives are byte-identical across setgid worktrees and restrictive CI modes',async t=>{
 const root=await mkdtemp(join(tmpdir(),'yolostart-archive-modes-'));
 t.after(()=>rm(root,{recursive:true,force:true}));
 for(const [name,mode,fileMode] of [['host',0o2775,0o664],['ci',0o700,0o600]] as const) {
  const source=join(root,name);await mkdir(join(source,'package/dist'),{recursive:true});
  await writeFile(join(source,'package/dist/artifact.gz'),'same compressed bytes');
  await chmod(join(source,'package'),mode);await chmod(join(source,'package/dist'),mode);
  await chmod(join(source,'package/dist/artifact.gz'),fileMode);
  createNativeArchive(source,join(root,name+'.tgz'));
 }
 assert.deepEqual(await readFile(join(root,'host.tgz')),await readFile(join(root,'ci.tgz')));
});
