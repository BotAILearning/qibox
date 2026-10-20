// Explicit reviewed package adoption. Ordinary builds only use the local lock.
import {readFile,writeFile,cp,mkdir,mkdtemp,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';import {execFileSync} from 'node:child_process';import path from 'node:path';import os from 'node:os';import {root} from './tooling.mjs';
const source=path.resolve(process.argv[2]||'D:/app开发/UI通用组件库');
const version='0.3.0',revision='2026-10-20',packageArchive=`qiapp-ui-${version}.tgz`,expected='a6a7e2fed1b8fcf559a2f74aa63cb9511e4c865d348c75c9e92b5c8526296f05';
const archive=path.join(source,'releases',packageArchive),sha=bytes=>createHash('sha256').update(bytes).digest('hex');
if(sha(await readFile(archive))!==expected)throw Error('Reviewed UI archive changed; inspect before replacing the lock');
const files=['styles.css','tokens.css','brands.css','base.css','components.css','settings.css','ai.css','composition.css','workspace.css'];
const stage=await mkdtemp(path.join(os.tmpdir(),'qibox-reviewed-ui-'));
try {
  execFileSync('tar',['-xzf',archive,'-C',stage,'package/package.json','package/docs/design-system.md',...files.map(n=>'package/src/'+n)],{windowsHide:true});
  const pkg=JSON.parse(await readFile(path.join(stage,'package/package.json'),'utf8')),spec=await readFile(path.join(stage,'package/docs/design-system.md'),'utf8');
  if(pkg.version!==version||!spec.includes('规范修订：'+revision))throw Error('Package metadata differs from reviewed standard');
  const target=path.join(root,'web/vendor/qiapp-ui');await mkdir(target,{recursive:true});const hashes={};
  for(const name of files){const file=path.join(stage,'package/src',name);hashes[name]=sha(await readFile(file));await cp(file,path.join(target,name));}
  await writeFile(path.join(target,'source-lock.json'),JSON.stringify({package:'@qiapp/ui',version,revision,files:hashes,packageArchive,packageArchiveSha256:expected,packagedSpecificationSha256:sha(Buffer.from(spec))},null,2)+'\n');
  await writeFile(path.join(target,'SOURCE.md'),`# QIAPP UI source\n\nPinned @qiapp/ui ${version} / specification ${revision}, explicitly adopted after the user's new-standard instruction.\nSource: reviewed releases/${packageArchive}; SHA-256 ${expected}.\nNine CSS assets are copied unchanged from the actual archive; source-lock.json records their hashes.\nOrdinary builds never read a sibling repository. Native HTML public patterns only; no claim of JavaScript Web Component migration.\nPrevious0.2.1 source and package remain in the earlier candidate history for exact rollback.\n`);
  await writeFile(path.join(target,'SETTINGS-SOURCE.md'),`# Settings source\n\nsettings.css and workspace.css belong to the same pinned ${version} archive. Reading defaults40; explicit density and touch44 are supplied by the shared runtime. See SOURCE.md and source-lock.json.\n`);
  console.log(JSON.stringify({version,revision,assets:files.length,archiveSha256:expected}));
}finally{if(!path.resolve(stage).startsWith(path.join(os.tmpdir(),'qibox-reviewed-ui-')))throw Error('Unexpected temporary extraction path');await rm(stage,{recursive:true,force:true});}
