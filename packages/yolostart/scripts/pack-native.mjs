// Native release archive, NOT the npm bootstrap. Legacy package/ layout keeps
// every historical Host restore path readable; private identity prevents npm use.
import {mkdir, mkdtemp, readFile, writeFile, cp, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const root=new URL('../',import.meta.url);
const {version}=JSON.parse(await readFile(new URL('package.json',root),'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error('Invalid native release version');
const build=spawnSync(process.execPath,['scripts/build-native.mjs'],{cwd:root,stdio:'inherit'});
if(build.error || build.status!==0) throw Error('Native build failed');
const releases=new URL('dist/releases/',root);
await mkdir(releases,{recursive:true});
const temp=await mkdtemp(fileURLToPath(new URL('.pack-',releases)));
try {
 await mkdir(`${temp}/package/dist/native`,{recursive:true});
 await writeFile(`${temp}/package/package.json`,JSON.stringify({name:'yolostart-native-release',version,private:true})+'\n');
 await cp(new URL(`dist/native/${version}/`,root),`${temp}/package/dist/native/${version}`,{recursive:true});
 const archive=fileURLToPath(new URL(`yolostart-${version}.tgz`,releases));
 const result=spawnSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--format=ustar','-czf',archive,'-C',temp,'package'],{stdio:'inherit'});
 if(result.error || result.status!==0) throw Error('Native release pack failed');
 console.log(archive);
} finally {await rm(temp,{recursive:true,force:true});}
