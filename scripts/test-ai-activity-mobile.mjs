import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { activityPage } from '../web/ai-activity-view.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const index = await readFile(path.join(root, 'web/index.html'), 'utf8');
const stylesheets = [...index.matchAll(/<link\b(?=[^>]*\brel=["']stylesheet["'])[^>]*\bhref=["']([^"']+)["'][^>]*>/gi)].map(match => match[1]);
assert.ok(stylesheets.length > 0, 'load the stylesheet chain used by the production page');
const css = (await Promise.all(stylesheets.map(file => readFile(path.join(root, 'web', file), 'utf8')))).join('\n');
const adoptSource = await readFile(path.join(root, 'web/qiapp-adopt.mjs'), 'utf8');
const output = path.join(root, 'reports/screenshots');
await mkdir(output, { recursive: true });
const now = Date.now();
const groupName = '华东区域渠道合作与售后问题跟进项目沟通群（第三批伙伴）';
const groupNickname = '十月试点联合项目组';
const senderName = '张同学（华东合作伙伴售后协调负责人）';
const incomingText = '上次确认的设置已完成，请帮忙看看这次运行结果，还有哪些需要调整的地方？';
const incomingLink = 'https://example.invalid/review/' + 'abcdefghijklmnopqrstuvwxyz0123456789'.repeat(10);
const state = {
  profiles: [{ id: 'profile-person', contact: 'contact-person', kind: 'person' }, { id: 'profile-group', contact: 'contact-group', kind: 'group' }],
  contacts: [{ id: 'contact-person', kind: 'person', label: '测试联系人' }, { id: 'contact-group', kind: 'group', label: groupName, nickname: groupNickname }],
  activity: [{ id: 'profile-person', contact: 'contact-person', kind: 'person', at: now, hasSent: true, needsHelp: false }],
  activityHistory: [],
  replyRecords: [],
  proactiveRecords: [],
  events: [{ id: 'skip-event', code: 'skip', target: 'profile-group', at: now, source: 'model-skip', trigger: 'realtime', reasonCode: 'model-no-reply', messageId: 'trigger-message', incomingMessages: [
    { senderName, timestamp: Math.floor(now / 1000), text: incomingText },
    { senderName, timestamp: Math.floor(now / 1000), text: incomingLink },
  ] }],
};
const records = [{ id: 'profile-person', messages: [{ id: 'sent-message', at: now, text: '这是一条用于 390 像素视口检查的完整执行记录', confirmed: true }] }];
const markup = activityPage(state, { source: 'reply', query: '', page: 0, expanded: ['profile-person'] }, records, false);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><html lang="zh-CN" data-qi-theme="light"><meta charset="utf-8"><style>${css}</style><body class="qiapp-product"><main id="ai-panel" data-page="activity"><div id="ai-content"><div class="ai-page-body">${markup}</div></div></main></body></html>`);
  await page.addScriptTag({ type: 'module', content: adoptSource });
  const replyCard = page.locator('.ai-reply-record-card[data-ai-reply-card="profile-person"]');
  const skipCard = page.locator('.ai-skip-record-card[data-ai-skip-record="skip-event"]');
  assert.equal(await replyCard.count(), 1, 'automatic replies keep their existing card layout');
  assert.equal(await replyCard.locator('[data-ai-open-conversation="profile-person"]').count(), 1);
  assert.equal(await replyCard.locator('.ai-reply-record-time small').textContent(), '最近执行时间');
  assert.equal(await replyCard.locator('.ai-record-message').textContent(), records[0].messages[0].text);
  assert.equal(await skipCard.count(), 1, 'unreplied records use one readable card per event');
  assert.equal(await skipCard.locator('[data-ai-locate-message]').count(), 0);
  assert.equal(await skipCard.locator('[data-ai-open-conversation="profile-group"]').count(), 1);
  assert.equal(await skipCard.locator('[data-ai-mark-reply="profile-group"]').count(), 1);
  assert.equal(await skipCard.locator('.ai-record-contact-name').textContent(), `${groupName}（${groupNickname}）`, 'keep the full group name and nickname');
  assert.equal(await skipCard.locator('.ai-review-record-person-copy small').textContent(), '群聊');
  assert.equal(await skipCard.locator('.ai-reply-record-time small').textContent(), '未回复时间');
  assert.equal(await skipCard.locator('section[aria-label="发送者与消息内容"]').count(), 1);
  assert.equal(await skipCard.locator('aside[aria-label="原因与来源"]').count(), 1);
  assert.match(await skipCard.locator('.ai-skip-source').textContent(), /模型判断.*群聊实时/);
  assert.equal(await skipCard.locator('.ai-skip-reason').textContent(), '模型判断本轮无需回复');
  assert.equal(await skipCard.locator('[data-ai-mark-reply]').textContent(), '需回复');
  assert.equal(await skipCard.locator('[data-ai-mark-reply]').isEnabled(), true);
  assert.equal(await skipCard.locator('[data-ai-mark-reply]').getAttribute('data-message-id'), 'trigger-message');
  const disclosure = skipCard.locator('details[data-ai-skip-messages="skip-event"]');
  assert.equal(await disclosure.getAttribute('open'), null, 'messages start collapsed');
  await disclosure.locator('summary').click();
  assert.equal(await disclosure.getAttribute('open'), '', 'native disclosure opens the saved messages');
  assert.deepEqual(await disclosure.locator('.ai-skip-sender').allTextContents(), [senderName, senderName]);
  assert.deepEqual(await disclosure.locator('.ap-record-text').allTextContents(), [incomingText, incomingLink], 'expansion preserves sender names and complete message text');
  await disclosure.locator('summary').click();
  assert.equal(await disclosure.getAttribute('open'), null, 'native disclosure can collapse again');
  await disclosure.locator('summary').click();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px viewport must not overflow horizontally');
  const overflow = await page.locator('#ai-content, .ai-review-record-head, .ai-review-record-body, .ai-skip-message').evaluateAll(nodes => nodes.filter(node => node.scrollWidth > node.clientWidth + 1).map(node => node.className || node.id));
  assert.deepEqual(overflow, [], 'long group names, senders and unbroken links must fit inside their own layout areas');
  const recordCellHeight = await replyCard.locator('.ai-reply-history').evaluate(node => node.getBoundingClientRect().height);
  assert.ok(recordCellHeight < 360, `expanded activity content should not leave a large blank column (got ${recordCellHeight}px)`);
  const openBox = await replyCard.locator('[data-ai-open-conversation]').boundingBox();
  await page.screenshot({ path: path.join(output, 'activity-mobile-390.png'), fullPage: true });
  assert.ok(openBox.height >= 44 && openBox.width >= 44, `open-chat action has a comfortable touch target: ${JSON.stringify(openBox)}`);
  const markBox = await skipCard.locator('[data-ai-mark-reply]').boundingBox();
  assert.ok(markBox.height >= 44 && markBox.width >= 44, `mark-reply action has a comfortable touch target: ${JSON.stringify(markBox)}`);
  const skipOpenBox = await skipCard.locator('[data-ai-open-conversation]').boundingBox();
  assert.ok(skipOpenBox.height >= 44 && skipOpenBox.width >= 44, `skip-record open-chat action has a comfortable touch target: ${JSON.stringify(skipOpenBox)}`);
  assert.equal(await skipCard.getAttribute('data-ai-record-menu'), 'skip-event');
  assert.equal(await skipCard.getAttribute('data-ai-record-menu-source'), 'skip');
  assert.equal(await replyCard.locator('.ai-reply-history-list [data-ai-record-menu="sent-message"][data-ai-record-menu-source="reply"]').count(), 1, 'confirmed records keep their controller menu anchors');
  await page.screenshot({ path: path.join(output, 'activity-mobile-390.png'), fullPage: true });
  assert.equal(await replyCard.locator('button.ai-record-message').count(), 0, 'record body is static text');
  // This fixture checks rendered layout and native disclosures. Business actions
  // and menu handling belong to the separately tested production controller.
  console.log('390px activity cards: full names and messages preserved; native disclosure expands and collapses; semantic sections, touch targets and controller menu anchors present; no horizontal page or content overflow. Static rendering does not exercise controller business actions.');
} finally { await browser.close(); }
