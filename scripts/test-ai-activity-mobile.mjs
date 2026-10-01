import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { activityPage } from '../web/ai-activity-view.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const css = await readFile(path.join(root, 'web/ai-workspace.css'), 'utf8');
const output = path.join(root, 'reports/screenshots');
await mkdir(output, { recursive: true });
const now = Date.now();
const state = {
  profiles: [{ id: 'profile-person', contact: 'contact-person', kind: 'person' }],
  contacts: [{ id: 'contact-person', kind: 'person', label: '测试联系人' }],
  activity: [{ id: 'profile-person', contact: 'contact-person', kind: 'person', at: now, hasSent: true, needsHelp: false }],
  activityHistory: [],
  replyRecords: [],
  proactiveRecords: [],
  events: [{ id: 'skip-event', code: 'skip', target: 'profile-person', at: now, source: 'model-skip', reasonCode: 'model-no-reply', messageId: 'trigger-message' }],
};
const records = [{ id: 'profile-person', messages: [{ id: 'sent-message', at: now, text: '这是一条用于 390 像素视口检查的完整执行记录', confirmed: true }] }];
const markup = activityPage(state, { source: 'reply', query: '', page: 0, expanded: ['profile-person'] }, records, false);
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.setContent(`<!doctype html><meta charset="utf-8"><style>${css}</style><main id="ai-panel">${markup}</main>`);
  assert.equal(await page.locator('.ai-reply-record-card').count(), 1);
  assert.equal(await page.locator('.ai-reply-record-card [data-ai-open-conversation]').count(), 1);
  assert.equal(await page.locator('.ap-skip-record-table td[data-label]').count(), 4);
  assert.equal(await page.locator('.ap-skip-record-table [data-ai-locate-message]').count(), 0);
  assert.equal(await page.locator('.ap-skip-record-table [data-ai-open-conversation]').count(), 1);
  assert.equal(await page.locator('.ap-skip-record-table [data-ai-mark-reply]').count(), 1);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '390px viewport must not overflow horizontally');
  const historyHeight = await page.locator('.ai-reply-history-list').evaluate(node => node.getBoundingClientRect().height);
  assert.ok(historyHeight < 360, `expanded activity content should remain bounded (got ${historyHeight}px)`);
  const openBox = await page.locator('.ai-reply-record-card [data-ai-open-conversation]').boundingBox();
  assert.ok(openBox.height >= 44, 'avatar and name have a comfortable touch target');
  const markBox = await page.locator('.ap-skip-record-table [data-ai-mark-reply]').boundingBox();
  assert.ok(markBox.height >= 44 && markBox.width >= 120, 'mark-reply action has a comfortable touch target');
  assert.equal(await page.locator('[data-ai-delete-record]').count(), 0, 'delete is only in the context menu');
  assert.equal(await page.locator('.ai-reply-history-list [data-ai-record-menu]').count(), 1);
  assert.equal(await page.locator('.ap-skip-record-table [data-ai-record-menu]').count(), 1);
  await page.screenshot({ path: path.join(output, 'activity-mobile-390.png'), fullPage: true });
  assert.equal(await page.locator('.ai-reply-history-list button.ai-record-message').count(), 0, 'record body is static text');
  console.log('390px activity cards: contact identity opens chat; delete stays in context menu; no horizontal page overflow.');
} finally { await browser.close(); }
