import {spawnSync} from 'node:child_process';

export function createNativeArchive(source, archive) {
  // Shared worktrees inherit setgid; CI does not. Normalize modes as well as
  // owners/timestamps so the same release has identical Host and dl bytes.
  const result=spawnSync('tar',['--sort=name','--mtime=@0','--owner=0','--group=0','--numeric-owner','--mode=a=rX,u+w,a-s','--format=ustar','-czf',archive,'-C',source,'package'],{stdio:'inherit'});
  if(result.error || result.status!==0) throw Error('Native release pack failed');
}
