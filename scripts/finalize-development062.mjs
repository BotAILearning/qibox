import {readFile,writeFile,readdir,mkdir,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {root,run,python} from './tooling.mjs';
const build='0.6.2-debug.002',report=path.join(root,'reports/development-2026-09-17');
const dir=path.join(root,'dist/releases/0.6.2',build),fpk=path.join(dir,`qibox-${build}-all.fpk`);
const sha=async p=>createHash('sha256').update(await readFile(p)).digest('hex');
const log=(await readFile(path.join(report,'package-final.txt'),'utf8')).split(/\r?\n/).filter(l=>l.startsWith('{')).map(JSON.parse).at(-1);
if(!log || log.sha256!==await sha(fpk)) throw Error('Package has not completed verification');
async function files(folder,base=folder){const out=[];for(const e of await readdir(folder,{withFileTypes:true})){if(e.name==='__pycache__')continue;const p=path.join(folder,e.name);if(e.isDirectory())out.push(...await files(p,base));else if(e.isFile())out.push(path.relative(base,p).replaceAll('\\','/'));}return out.sort();}
const parity=[];
for(const name of ['server','public','config']){
 const original=path.join(root,name),stage=path.join(root,'build/qibox-all/app',name),expected=await files(original),actual=await files(stage);
 if(JSON.stringify(expected)!==JSON.stringify(actual))throw Error('Staged file inventory differs: '+name);
 for(const file of expected){const hash=await sha(path.join(original,file));if(hash!==await sha(path.join(stage,file)))throw Error('Staged source differs: '+name+'/'+file);parity.push({file:name+'/'+file,sha256:hash});}
}
await writeFile(path.join(report,'source-stage-parity.json'),JSON.stringify({build,files:parity},null,2));
const ledger=path.join(root,'docs/release/VERSION-CONTROL.md');let text=await readFile(ledger,'utf8');
if(!text.includes('## 开发测试登记：'+build)){
 text=text.replace('# 栖盒版本控制与封版发布',`# 栖盒版本控制与封版发布\n\n## 开发测试登记：${build}（2026-09-17）\n\n用户在“汇总新版本待开发功能”明确授权本批 F1–F9、B1、主动聊天发送故障修复及声音重连提示移除。F6 更正为“无法回复”。[交付与边界](../../reports/development-2026-09-17/DELIVERY.md)。双架构 fnOS FPK ${log.bytes} 字节，SHA-256 \`${log.sha256}\`。Node 476 通过、1 项 UGOS 实机检查跳过；Python 207 通过；七组浏览器回归及包校验通过，最终 UI 补测见验收。Debug001 为内部候选，Debug002 保留全局等待关闭的继承语义并补充异步界面保护，为最终交付。未部署 NAS、未真实收发、未公开发布；BUG-017 整个现场故障仍待实机复验，任务保留。\n`);
 await writeFile(ledger,text);
}
const selection=[];
for(const name of ['server','web','scripts','test','config','packaging','docs','licenses'])for(const f of await files(path.join(root,name)))selection.push(name+'/'+f);
selection.push('package.json','package-lock.json','README.md','NOTICE.md');selection.sort();
const manifest=[];for(const file of selection)manifest.push({file,sha256:await sha(path.join(root,file))});
await mkdir(dir,{recursive:true});const mf=path.join(dir,'SOURCE-MANIFEST.json');await writeFile(mf,JSON.stringify({build,files:manifest},null,2));
const zip=path.join(dir,`qibox-${build}-source.zip`);
await run(python,['-c',"import json,pathlib,sys,zipfile; root=pathlib.Path(sys.argv[1]); manifest=json.loads(pathlib.Path(sys.argv[2]).read_text(encoding='utf-8')); z=zipfile.ZipFile(sys.argv[3],'x',zipfile.ZIP_DEFLATED); [z.write(root/f['file'],f['file']) for f in manifest['files']]; z.close()",root,mf,zip]);
const zipSha=await sha(zip);
await writeFile(path.join(dir,'SHA256SUMS.txt'),`${log.sha256}  ${path.basename(fpk)}\n${zipSha}  ${path.basename(zip)}\n${await sha(mf)}  SOURCE-MANIFEST.json\n`);
await writeFile(path.join(report,'DELIVERY.md'),`# ${build} 交付\n\n用户授权的新版本开发已完成本地实现、回归及 Debug 打包。F6“恢复”已更正为“回复”，启动和重连时的声音中断提示已移除。\n\n- [飞牛 x86_64 / ARM64 通用 Debug 安装包](../../dist/releases/0.6.2/${build}/${path.basename(fpk)})\n- 大小：${log.bytes} 字节；SHA-256：\`${log.sha256}\`。\n- [对应源码快照](../../dist/releases/0.6.2/${build}/${path.basename(zip)})；SHA-256：\`${zipSha}\`。\n- [文件哈希清单](../../dist/releases/0.6.2/${build}/SOURCE-MANIFEST.json)、[包和源码校验值](../../dist/releases/0.6.2/${build}/SHA256SUMS.txt)。\n- [逐项验收及实机边界](ACCEPTANCE.md)、[源码与构建输入对应检查](source-stage-parity.json)、[包内校验](package-final.txt)。\n\n本地 Node 476 项通过，1 项 UGOS 实机检查跳过；Python 207 项通过；七组浏览器回归通过。最终界面补测验证继承关闭状态、正确对象应用和异步切换保护。包内 ${log.verifiedFiles} 个文件通过校验；server/public/config 与当前工作区逐文件对应。工作区无 Git 仓库，以修改前 baseline-source.zip、本次源码快照及文件哈希追溯，不声称 Git 提交来源。\n\n**尚未升级 NAS，也未进行真实微信收发。** BUG-017 已修复一个现场确认的通讯录页导航阻塞并加上受控重试，但整体故障仍需安装后复验，来源任务保留。图片/文件粘贴的 GTK 与微信预览/接收仍待实机验收。其他完成项的来源任务按用户指令归档，记录见 ARCHIVE.md。\n\n0.6.1 原包保留。0.6.2-debug.001 为内部候选；最终交付为 Debug002，未覆盖旧包。UGOS 和其他未确认需求不在本批。\n`);
await writeFile(path.join(report,'PROGRESS.md'),`# 2026-09-17 开发批次\n\n用户授权 F1–F9、B1、BUG-017 和声音重连提示移除。F6 改为“无法回复”。\n\n基线 0.6.1-debug.001，修改前已保存 baseline-source.zip。最终 ${build} 本地回归、源码对应检查、FPK 打包验证完成。详见 DELIVERY.md 和 ACCEPTANCE.md。\n\n未部署 NAS、未真实发送。BUG-017 继续追踪实机复验。归档完成项的来源任务，具体结果见 ARCHIVE.md。\n`);
console.log(JSON.stringify({build,package:fpk,sha256:log.sha256,source:zip,sourceSha256:zipSha,parityFiles:parity.length,sourceFiles:manifest.length}));
