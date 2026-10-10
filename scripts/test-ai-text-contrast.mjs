import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const fixture = await proactiveFixture(), { ai, bridge } = fixture;
const output = path.resolve(root, process.env.QIBOX_TEST_OUTPUT || 'reports/ai-text-contrast');
const report = { startedAt: new Date().toISOString(), syntheticRecords: true, realWechatSends: 0, pages: [], boundary: 'Rendered opaque text/background combinations; disabled controls excluded. Images, translucent layers and full WCAG conformance require separate review.' };
let browser;
try {
  await mkdir(output, { recursive: true });
  await ai.saveReplyProfile({ contact: bridge.contacts[0].id, style: { summary: '简洁自然' }, strategy: { replyGoal: '回应对方' } });
  const p = ai.profiles().find(p => p.contact === bridge.contacts[0].id);
  await ai.setReplyOptions({contact:p.contact,enabled:true,judgeReply:false});
  p.sentMessages = [{ id: 'contrast-reply', at: Date.now(), source: 'reply', body: ai.vault.seal({ text: '合成回复，用于文字可读性检查。' }) }];
  ai.event('error', p.id, 'reply', '合成模型服务超时，尚未发送');
  ai.data.proactiveTasks = ['running','paused','ended','failed'].map((status,i)=>({id:`contrast-task-${i}`,account:ai.data.account,name:`合成${status}任务`,taskType:'work',revision:1,contacts:[{id:p.contact,label:p.label,profileId:p.id}],goal:'合成任务目标',requirements:'合成补充要求',schedule:{cycle:'once'},status,nextAt:null,createdAt:Date.now(),updatedAt:Date.now()}));
  ai.data.analysisReports.push({id:'11111111-1111-4111-8111-111111111111',account:ai.data.account,contact:p.contact,label:p.label,createdAt:Date.now(),count:1,report:'合成分析报告，仅用于可读性检查。'});
  await ai.save();
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await context.grantPermissions(['local-network-access'], { origin: new URL(fixture.url).origin });
  const page = await context.newPage();
  await page.goto(fixture.url);
  await page.locator('[data-action=open]').click();
  await page.waitForFunction(() => document.querySelector('#desktop-status').hidden && document.querySelector('#remote-canvas canvas')?.width === 1280);
  await page.locator('#ai-open').click();
  const checkText = async name => {
    const rows = await page.locator('#ai-panel').evaluate(panel => {
      const rgb = s => s.match(/[\d.]+/g).map(Number);
      const lum = c => c.slice(0, 3).map(x => x / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4).reduce((a, x, i) => a + x * [.2126, .7152, .0722][i], 0);
      const rows = [];
      for (const e of panel.querySelectorAll('*')) {
        if (![...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()) || e.closest('[disabled], [aria-disabled=true]') || !e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue;
        const style = getComputedStyle(e), fg = rgb(style.color);
        let parent = e, bg = null, translucent = fg.length === 4 && fg[3] !== 1;
        while (parent) {
          const s = getComputedStyle(parent), value = rgb(s.backgroundColor);
          if (+s.opacity !== 1) translucent = true;
          if (value.length === 3 || value[3] > 0) { bg = value; if (value.length === 4 && value[3] !== 1) translucent = true; break; }
          parent = parent.parentElement;
        }
        if (translucent) continue;
        bg ||= [255, 255, 255];
        const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
        const size = parseFloat(style.fontSize), large = size >= 24 || size >= 18.666 && +style.fontWeight >= 700;
        rows.push({ tag: e.tagName, class: e.className, text: e.textContent.trim().slice(0, 80), color: style.color, background: bg, ratio, required: large ? 3 : 4.5 });
      }
      return rows;
    });
    const failures = rows.filter(row => row.ratio < row.required);
    report.pages.push({ name, textPairs: rows.length, failures });
    await page.screenshot({ path: path.join(output, `${report.pages.length}-page.png`) });
  };
  for (const name of ['自动回复', '主动聊天', '执行记录', '分析报告', '系统设置']) {
    await page.locator('.ai-main-tabs').getByRole('button', { name, exact: true }).click();
    if(name==='自动回复'){await page.locator(`[data-ai-object="${p.contact}"]`).click();await page.getByRole('switch',{name:'多轮交流',exact:true}).check();}
    if (name === '执行记录') {
      await page.locator('.ai-reply-record-preview').filter({ hasText: '合成回复' }).waitFor();
      await page.locator('[data-ai-record-expand]').click();
      await page.locator('.ap-record-errors > summary').click();
    }
    if (name === '分析报告') {
      await page.locator('[data-ai-optional=analysis] > summary').click();
      await page.locator('[data-ai-optional=analysis-media] > summary').click();
    }
    await checkText(name);
    if(name==='自动回复'){
      await page.locator('[data-ai-object-section=style]').click();await checkText('对象聊天风格');
      await page.locator('[data-ai-object-section=memory]').click();await checkText('对象聊天记忆');
    }
  }
  report.passed = report.pages.every(page=>page.failures.length===0);
  assert.ok(report.passed, JSON.stringify(report.pages.filter(page=>page.failures.length)));
} finally {
  try { await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2)); }
  finally { await browser?.close(); await fixture.close(); }
}
console.log(JSON.stringify(report));
