import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
import { readMemory, mergeMemory } from '../server/ai-wiki.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const groupContact = { id: key('fixture-group-contact'), label: '测试群聊', kind: 'group' };
bridge.contacts.push(groupContact); bridge.messages.set(groupContact.id, [{ id: 'group-message', direction: 'self', text: 'fixture' }]);
const contact = bridge.contacts[0].id;
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('Wiki 浏览器回归'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.configure(modelConfig); await ai.scan();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator(`[data-ai-object="${contact}"]`).click();
  const settle = () => page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false');
  const save = async () => { await page.getByRole('button', { name: '保存设置', exact: true }).click(); await settle(); };
  const expand = async () => { if (!(await page.locator('.ai-memory-fold').evaluate(node => node.open))) await page.locator('.ai-memory-fold > summary').click(); };
  const add = async field => {
    const section = page.locator(`[data-ai-wiki-field="${['workplace','employer'].includes(field) ? 'work' : field}"]`);
    await section.locator(`[data-ai-wiki-add-field="${field}"]`).click();
    return section.locator('.ai-wiki-bubble').last();
  };
  await expand();
  assert.equal(await page.locator('.ai-wiki-field').count(), 10, `固定模板显示全部基础信息字段和其他；工作地点与工作单位位于同一模块。页面文本：${(await page.locator('#ai-panel').innerText()).slice(0,1400)}`);
  assert.equal(await page.locator('[data-ai-wiki-field="work"] .ai-wiki-bubble').count(), 0);
  assert.equal(await page.locator('.ai-memory-fold h4').first().textContent(), '聊天记忆');
  await page.locator('[data-ai-wiki-field="name"] h5').waitFor();
  assert.equal(await page.locator('[data-ai-wiki-field="other"] textarea[aria-label="信息内容"]').count(), 0, '空字段保持空白，不强制创建条目');
  let row = await add('birthday');
  await row.locator('[aria-label="信息类型"]').selectOption('birthday'); await row.locator('[aria-label="信息内容"]').fill('正月初八');
  assert.equal(await row.locator('[aria-label="生日历法"]').inputValue(), '');
  await save();
  if (!ai.profiles().some(item => item.contact === contact)) throw new Error(`Wiki 初次保存未创建档案: ${await page.locator('#ai-feedback').textContent()}`);
  let profile = ai.profiles().find(item => item.contact === contact);
  assert.deepEqual(readMemory(ai.vault, ai.data.profiles[profile.id]).entries.map(entry => entry.calendar), [undefined], '保存其他内容时未确认历法保持未知');
  assert.equal(ai.data.profiles[profile.id].replyStrategy, undefined, '首次建立 Wiki 不生成回复策略');
  assert.equal(ai.data.replyTargets.includes(profile.id), false, '首次建立 Wiki 不启用回复');
  const savedBeforeDraft = readMemory(ai.vault, ai.data.profiles[profile.id]).entries;
  const draftRow = await add('phone'); await draftRow.locator('[aria-label="信息内容"]').fill('13900000000');
  assert.deepEqual(readMemory(ai.vault, ai.data.profiles[profile.id]).entries, savedBeforeDraft, '新增内容在点击保存设置前仅为草稿');
  await draftRow.locator('[data-ai-wiki-remove]').click();
  assert.deepEqual(readMemory(ai.vault, ai.data.profiles[profile.id]).entries, savedBeforeDraft, '删除草稿内容不会提前影响已保存记忆');
  row = page.locator('.ai-wiki-bubble').last(); await row.locator('[aria-label="生日历法"]').selectOption('lunar'); await save();
  profile = ai.profiles().find(item => item.contact === contact);
  assert.equal(readMemory(ai.vault, ai.data.profiles[profile.id]).entries[0].calendar, 'lunar');

  row = await add('residence'); await row.locator('[aria-label="信息内容"]').fill('测试地址');
  assert.equal(await row.locator('[aria-label="开始时间"]').count(), 0, '地址记忆不要求起止时间');
  assert.equal(await row.locator('.ai-wiki-recorded').count(), 1, '地址展示单个时间');
  await save();
  profile = ai.profiles().find(item => item.contact === contact);
  const residence = readMemory(ai.vault, ai.data.profiles[profile.id]).entries.find(entry => entry.field === 'residence');
  assert.equal(residence.text, '测试地址'); assert.equal(residence.recordedAt, undefined, '手动新建地址不冒用编辑时间'); assert.equal(residence.from, undefined); assert.equal(residence.to, undefined);
  assert.match(await row.locator('.ai-wiki-recorded').textContent(), /时间：未知/);

  row = await add('school'); await row.locator('[aria-label="学历"]').fill('本科'); await row.locator('[aria-label="信息内容"]').fill('示例大学');
  assert.equal(await row.locator('.ai-wiki-school-name').textContent(), '本科：示例大学');
  await save();
  assert.ok(readMemory(ai.vault, ai.data.profiles[profile.id]).entries.some(entry => entry.field === 'school' && entry.degree === '本科' && entry.text === '示例大学'));
  await add('employer'); await page.locator('[data-ai-wiki-field="work"] .ai-wiki-bubble').last().locator('[aria-label="信息内容"]').fill('示例公司'); await save();
  assert.equal(await page.locator('[data-ai-wiki-field="work"] .ai-wiki-bubble').count(), 1, '工作地点与工作单位共用一个模块');

  for (const phone of ['13800000001','13800000002']) {
    row = await add('phone'); await row.locator('[aria-label="信息内容"]').fill(phone);
  }
  await save();
  let phones = readMemory(ai.vault, ai.data.profiles[profile.id]).entries.filter(entry => entry.field === 'phone');
  assert.deepEqual(phones.map(entry => entry.text).sort(), ['13800000001','13800000002'], '同字段多值分别保存');
  row = await add('other'); await row.locator('[aria-label="信息内容"]').fill('喜欢徒步和摄影\n我们一起去过西湖');
  const textareaSize = await row.locator('textarea[aria-label="信息内容"]').evaluate(node => { const box=node.getBoundingClientRect(); return {height:box.height,scrollHeight:node.scrollHeight,right:box.right,parentRight:node.closest('.ai-wiki-field').getBoundingClientRect().right}; });
  assert.ok(textareaSize.height >= 55 && textareaSize.height >= textareaSize.scrollHeight - 1, '其他记忆文本框随内容增高');
  assert.ok(Math.abs(textareaSize.parentRight-textareaSize.right) < 28, '其他记忆输入区域右侧与字段说明区对齐');
  await save();
  const checkBubbleLayout = async () => {
    const boxes = await page.locator('.ai-wiki-bubble').evaluateAll(rows => rows.map(row => {
      const bubble = row.getBoundingClientRect(), input = row.querySelector('[aria-label="信息内容"]').getBoundingClientRect();
      return { bubbleWidth: bubble.width, inputWidth: input.width, inputRight: input.right, bubbleRight: bubble.right, multiline: input.height > 42 };
    }));
    assert.ok(boxes.every(box => box.inputWidth >= 100 && (box.multiline || box.inputRight <= box.bubbleRight - 30)), `Wiki 内容输入框可见且不与删除按钮重叠：${JSON.stringify(boxes)}`);
  };
  await checkBubbleLayout();
  if (process.env.QIBOX_WIKI_SCREENSHOT) {
    await page.locator('.ai-memory-fold').screenshot({ path: process.env.QIBOX_WIKI_SCREENSHOT });
    await page.setViewportSize({ width: 390, height: 844 });
    await checkBubbleLayout();
    await page.locator('.ai-memory-fold').screenshot({ path: process.env.QIBOX_WIKI_SCREENSHOT.replace(/\.png$/i, '-mobile.png') });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator(`[data-ai-object="${contact}"]`).click(); await expand();
  const phoneRows = page.locator('.ai-wiki-bubble').filter({ has: page.locator('[aria-label="信息类型"] option[value="phone"]:checked') });
  assert.equal(await phoneRows.count(), 2, '重新打开后两个手机号仍为独立泡泡');
  await phoneRows.nth(0).locator('[aria-label="信息内容"]').fill('13800000003'); await save();
  phones = readMemory(ai.vault, ai.data.profiles[profile.id]).entries.filter(entry => entry.field === 'phone');
  assert.deepEqual(phones.map(entry => entry.text).sort(), ['13800000002','13800000003'], '编辑一个值不影响另一个值');

  const residenceIndex = await page.locator('.ai-wiki-bubble').evaluateAll(nodes => nodes.findIndex(node => node.querySelector('[aria-label="信息类型"]')?.value === 'residence'));
  await page.locator('.ai-wiki-bubble').nth(residenceIndex).locator('[data-ai-wiki-remove]').click();
  await save();
  profile = ai.profiles().find(item => item.contact === contact);
  assert.equal(readMemory(ai.vault, ai.data.profiles[profile.id]).entries.some(entry => entry.field === 'residence'), false);
  const storedProfile = ai.data.profiles[profile.id];
  Object.assign(storedProfile, mergeMemory(ai.vault, storedProfile, { entries: [{ field: 'residence', text: '测试地址', from: Date.parse('2026-09-25T00:00:00+08:00'), to: Date.parse('2026-09-28T23:59:59+08:00') }] }, ai.now()));
  assert.equal(readMemory(ai.vault, storedProfile).entries.some(entry => entry.field === 'residence'), false, '手动删除的事实不会被增量学习自动加回');

  const secondContact = bridge.contacts[1].id;
  await page.locator(`[data-ai-object="${secondContact}"]`).click(); await settle(); await expand();
  row = await add('name'); await row.locator('[aria-label="信息内容"]').fill('新联系人 Wiki');
  if (!(await page.locator('[data-ai-fold=reply]').evaluate(node => node.open))) await page.locator('[data-ai-fold=reply] summary').click();
  if (!(await page.locator('[data-ai-fold=strategy]').evaluate(node => node.open))) await page.locator('[data-ai-fold=strategy] summary').click();
  await page.locator('[name=replyGoal]').fill('新联系人的回复目的');
  await page.locator('[name=facts]').fill('已确认事实'); await page.locator('[name=boundaries]').fill('不承诺');
  await page.locator('#ai-object-form [name=enabled]').check(); await save();
  const secondProfile = ai.profiles().find(item => item.contact === secondContact);
  assert.ok(secondProfile?.replyStrategy, '新联系人同表单编辑回复字段时写入回复策略');
  assert.equal(secondProfile.replyStrategy.replyGoal, '新联系人的回复目的');
  assert.ok(ai.data.replyTargets.includes(secondProfile.id), '新联系人明确启用时加入回复目标');
  assert.equal(readMemory(ai.vault, ai.data.profiles[secondProfile.id]).entries[0].text, '新联系人 Wiki', '新联系人同表单 Wiki 内容也保存');

  await page.locator('[data-ai-kind="group"]').click(); await page.locator(`[data-ai-object="${groupContact.id}"]`).click(); await settle(); await expand();
  row = await add('other'); await row.locator('[aria-label="信息内容"]').fill('群聊 Wiki'); await save();
  let groupProfile = ai.profiles().find(item => item.contact === groupContact.id);
  assert.equal(groupProfile?.replyStrategy, undefined, '群聊 Wiki-only 不得因不存在的个人回复开关而创建策略');
  if (!(await page.locator('[data-ai-fold=reply]').evaluate(node => node.open))) await page.locator('[data-ai-fold=reply] summary').click();
  await page.locator('[name=replyGoal]').fill('群聊回复目的'); await page.locator('[name=atMe]').check(); await save();
  groupProfile = ai.profiles().find(item => item.contact === groupContact.id);
  assert.equal(groupProfile.replyStrategy.replyGoal, '群聊回复目的', '新群聊同表单回复策略按群聊类型保存');
  assert.equal(groupProfile.groupOptions.atMe, true, '新群聊提及时回复开关保存');

  await ai.saveReplyProfile({ contact, style: ai.publicState().schema.defaultStyle, strategy: { replyGoal: '原回复目标', facts: '已确认事实', boundaries: '不承诺', maxRounds: 50 } });
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  await page.locator(`[data-ai-object="${contact}"]`).click(); await expand();
  if (!(await page.locator('[data-ai-fold=reply]').evaluate(node => node.open))) await page.locator('[data-ai-fold=reply] summary').click();
  await page.locator('[name=replyGoal]').fill('不应写入的新目标');
  row = await add('other'); await row.locator('[aria-label="信息内容"]').fill('保存故障测试');
  ai.editContactMemory = async () => { throw new Error('模拟 Wiki 保存失败'); };
  await save();
  assert.equal(ai.data.profiles[profile.id].replyStrategy.replyGoal, '原回复目标', 'Wiki 保存失败时后续回复策略没有写入');
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ passed: true, checks: ['未保存的记忆编辑仅保留为草稿', '保存设置后写入与农历保存', '地址和工作信息只记录单个时间点', '学历学校显示为学历加学校', '工作地点与工作单位共用模块', '同字段多值保存与独立编辑', '删除抑制学习回填', '双方纪念日字段说明', '新联系人同表单 Wiki 与回复设置', 'Wiki 保存失败不写回复策略', '无浏览器运行时异常'] }));
} finally { await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot); }
