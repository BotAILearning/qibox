import {createRequire} from 'node:module';
import {readFile,mkdir} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {playwrightPath} from './tooling.mjs';
import {activityPage, proactiveRecordRows} from '../web/ai-activity-view.mjs';
const {chromium}=createRequire(import.meta.url)(playwrightPath);
const at=Date.now(), label='33 <安全测试>', nickname='黄三岁吖💚 很长的联系人昵称';
const avatarUrl='https://wx.qlogo.cn/test-avatar';
const state={contacts:[{id:'c',label,nickname,avatarUrl,kind:'person'}],profiles:[],activity:[{id:'p',contact:'c',label,nickname,kind:'person',hasSent:true,at}],events:[]};
const records=[{id:'p',messages:Array.from({length:30},(_,i)=>({id:'m'+i,at:at-i*60000,text:'这是一条执行记录，长内容应自然换行。'.repeat(i%3+1),confirmed:true}))}];
const css=await readFile('web/ai-workspace.css','utf8');
const browser=await chromium.launch({channel:'msedge',headless:true});
await mkdir('reports/records-0927',{recursive:true});
try{const page=await browser.newPage();
await page.route('https://wx.qlogo.cn/**',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="#e26f76"/></svg>'}));
for(const width of [320,390,430,768,1024,1440]){
await page.setViewportSize({width,height:900});
await page.setContent('<style>body{margin:0}'+css+'</style><main id="ai-panel"><div class="ai-page-body">'+activityPage(state,{source:'reply',expanded:['p']},records)+'</div></main>');
assert.equal(await page.locator('.ai-reply-record-person strong').textContent(),label+'（'+nickname+'）');
assert.equal(await page.locator('.ai-contact-nick').count(),1);
assert.equal(await page.locator('.ai-reply-record-avatar img').count(),1);
await page.locator('.ai-reply-record-avatar img').evaluate(image=>image.decode());
assert.ok(!await page.locator('.ai-reply-record-person').innerText().then(s=>s.includes('<span')));
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+' overflow');
const a=await page.locator('.ai-reply-record-person').boundingBox(),b=await page.locator('.ai-reply-record-time').boundingBox();
assert.ok(a.x+a.width<=b.x+1||a.y+a.height<=b.y+1,width+' identity/time overlap');
const button=await page.locator('[data-ai-summary-profile]').boundingBox();assert.ok(button.width>=76&&button.height>=44);
assert.equal(await page.locator('[data-ai-summary-range]').getAttribute('aria-label'),label+'（'+nickname+'）的总结时间范围');
await page.screenshot({path:'reports/records-0927/records-'+width+'.png',fullPage:true});
}
for(const width of [390,1440]){
await page.setViewportSize({width,height:900});
const proactive=proactiveRecordRows({contacts:[{id:'c',label,nickname,avatarUrl,kind:'person'}],profiles:[{id:'p',contact:'c'}],proactiveRecords:[{id:'r',contact:'c',profileId:'p',label,nickname,taskName:'问候任务',at,status:'sent',text:'本次主动聊天内容'}]});
await page.setContent('<style>body{margin:0}'+css+'</style><main id="ai-panel"><section class="ai-activity-page"><div id="ai-proactive-records">'+proactive+'</div></section></main>');
assert.equal(await page.locator('[data-ai-open-conversation="p"]').count(),1);
await page.locator('.ai-reply-record-avatar img').evaluate(image=>image.decode());
assert.equal(await page.locator('[data-ai-record-menu="r"]').count(),1);
assert.equal(await page.locator('[data-ai-delete-record]').count(),0);
assert.equal(await page.locator('.ap-proactive-record-table th').count(),4);
assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),width+' proactive overflow');
await page.screenshot({path:'reports/records-0927/proactive-'+width+'.png',fullPage:true});
}
console.log('PASS: reply and proactive layouts, nickname escaping, identity/time bounds, summary touch target');
}finally{await browser.close()}
