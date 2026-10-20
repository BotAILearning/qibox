import {createRequire} from 'node:module';
import {createServer} from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import {root,playwrightPath} from './tooling.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const output=path.resolve(root,process.argv[2]||'reports/legal-pages-ui');await fs.mkdir(output,{recursive:true});
const server=createServer(async(req,res)=>{try{
 const name=decodeURIComponent(new URL(req.url,'http://localhost').pathname).replace(/^\/+/, '')||'index.html';
 const base=process.env.QIBOX_LEGAL_HTML_DIR&&['privacy.html','terms.html'].includes(name)?path.resolve(process.env.QIBOX_LEGAL_HTML_DIR):path.join(root,'public');
 const file=path.resolve(base,name);if(!file.startsWith(base+path.sep))throw Error('outside test assets');
 const bytes=await fs.readFile(file);res.setHeader('Content-Type',file.endsWith('.css')?'text/css':file.endsWith('.html')?'text/html; charset=utf-8':'application/octet-stream');res.end(bytes);
 }catch{res.writeHead(404);res.end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));
const browser=await chromium.launch({channel:'msedge',headless:true});
const report={scope:'Actual built legal pages and locked shared CSS in isolated static browser; no legal text acceptance, NAS session, model or WeChat operation.',checks:[],errors:[],passed:false};
try{
 const page=await browser.newPage();
 for(const file of ['privacy.html','terms.html'])for(const theme of ['light','dark'])for(const [width,height]of [[1280,800],[1440,900],[375,812],[320,812]]){
  await page.setViewportSize({width,height});await page.emulateMedia({colorScheme:theme});await page.goto(`http://127.0.0.1:${server.address().port}/${file}`);
  const state=await page.evaluate(()=>{const h1=document.querySelector('h1'),h2=document.querySelector('h2'),link=document.querySelector('a'),p=document.querySelector('article>p');return{width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth,h1:getComputedStyle(h1).fontSize,h2:getComputedStyle(h2).fontSize,body:getComputedStyle(document.body).fontSize,font:getComputedStyle(document.body).fontFamily,color:getComputedStyle(document.body).color,background:getComputedStyle(document.body).backgroundColor,back:link.getBoundingClientRect().toJSON(),paragraph:p?.getBoundingClientRect().toJSON(),legalTextLength:document.querySelector('article').textContent.length};});
  report.checks.push({file,theme,width,height,...state});
  await page.screenshot({path:path.join(output,file.replace('.html','')+'-'+width+'-'+theme+'.png')});
  const failures=[];if(state.overflow)failures.push('unexpected horizontal overflow');if(state.h1!=='24px'||state.h2!=='16px'||state.body!=='14px')failures.push('reading-page typography');if(state.back.height<(width<640?44:32)||state.back.width<44)failures.push('return hit target');
  const rgb=state.background.match(/[\d.]+/g).map(Number);if(theme==='dark'&&!(rgb[0]<70&&rgb[1]<70&&rgb[2]<70&&state.background!=='rgba(0, 0, 0, 0)'))failures.push('dark surface');if(!state.font.startsWith('Inter'))failures.push('shared font');
  await page.keyboard.press('Tab');if(!await page.getByRole('link',{name:'← 返回栖盒',exact:true}).evaluate(e=>e===document.activeElement))failures.push('keyboard return focus');
  if(failures.length)report.errors.push({file,theme,width,failures});
 }
 report.passed=report.errors.length===0;assert.ok(report.passed,JSON.stringify(report.errors));
 // Check the existing return destination without adding an acceptance action.
 await page.getByRole('link',{name:'← 返回栖盒',exact:true}).press('Enter');await page.waitForURL('http://127.0.0.1:'+server.address().port+'/');report.returnNavigation=true;
}finally{await fs.writeFile(path.join(output,'report.json'),JSON.stringify(report,null,2));await browser.close();await new Promise(r=>server.close(r));}
console.log(JSON.stringify({checks:report.checks.length,passed:report.passed}));
