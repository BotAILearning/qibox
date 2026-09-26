import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {playwrightPath} from './tooling.mjs';
import {activityPage} from '../web/ai-activity-view.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const at=Date.now(), label='33 <安全测试>', nickname='黄三岁吖💚 很长的联系人昵称';
const state={contacts:[],profiles:[],activity:[{id:'p',label,nickname,kind:'person',hasSent:true,at}],events:[]};
const records=[{id:'p',messages:Array.from({length:30},(_,i)=>({id:'m'+i,at:at-i*60000,text:'这是一条执行记录，长内容应自然换行。'.repeat(i%3+1),confirmed:true}))}];
const css=await readFile('web/ai-workspace.css','utf8');
const browser=await chromium.launch({channel:'msedge',headless:true});
await mkdir('reports/records-0927',{recursive:true});
try{const page=await browser.newPage();
for(const width of [320,390,430,768,1024,1440]){
await page.setViewportSize({width,height:900});
await page.setContent('<style>body{margin:0}'+css+'</style><main id="ai-panel"><div class="ai-page-body">'+activityPage(state,{source:'reply',expanded:['p']},records)+'</div></main>');
assert.equal(await page.locator('.ai-reply-record-person strong').textContent(),label+'（'+nickname+'）');
assert.equal(await page.locator('.ai-contact-nick').count(),1);
assert.ok(!await page.locator('.ai-reply-record-person').innerText().then(s=>s.includes('<span')));
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+' overflow');
const a=await page.locator('.ai-reply-record-person').boundingBox(),b=await page.locator('.ai-reply-record-time').boundingBox();
assert.ok(a.x+a.width<=b.x+1||a.y+a.height<=b.y+1,width+' identity/time overlap');
const button=await page.locator('[data-ai-summary-profile]').boundingBox();assert.ok(button.width>=76&&button.height>=44);
assert.equal(await page.locator('[data-ai-summary-range]').getAttribute('aria-label'),label+'（'+nickname+'）的总结时间范围');
await page.screenshot({path:'reports/records-0927/records-'+width+'.png',fullPage:true});
}console.log('PASS: six widths, nickname escaping, identity/time bounds, summary touch target');
}finally{await browser.close()}
