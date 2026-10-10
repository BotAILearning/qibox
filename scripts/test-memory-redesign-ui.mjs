import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createApplication } from '../server/index.mjs';
import { root, playwrightPath } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig, key } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';
import { readMemory } from '../server/ai-wiki.mjs';

const { chromium } = createRequire(import.meta.url)(playwrightPath);
const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
const person = bridge.contacts[0].id;
const group = { id: key('memory-redesign-group'), label: '测试群聊', kind: 'group' };
bridge.contacts.push(group);
bridge.messages.set(group.id, [{ id: key('group-message'), direction: 'other', sender: '小李', text: '周六一起布置场地' }]);
const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
  runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
const space = await app.users.get('development'); await space.setConsent(true); app.library.download(); await app.library.working;
const meta = await space.add('记忆改版浏览器回归'); await space.start(meta.id); const ai = space.get(meta.id).ai;
clearInterval(ai.timer); await ai.configure(modelConfig); await ai.scan();
let browser;
try {
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(12000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  await page.locator('[data-action=open]').first().click(); await page.locator('#ai-open').click();
  const save = async () => {
    await page.locator('#ai-object-form button[type="submit"]').click();
    await page.waitForFunction(() => document.querySelector('#ai-panel').getAttribute('aria-busy') === 'false');
  };
  const category = async id => page.locator(`[data-ai-memory-category="${id}"]`).click();
  const add = async (section, field, value) => {
    await page.locator(`[data-ai-wiki-field="${section}"] [data-ai-wiki-add-field="${field}"]`).click();
    const row = page.locator(`[data-ai-wiki-field="${section}"] .ai-wiki-bubble`).last();
    await row.locator('[aria-label="信息内容"]').fill(value);
    return row;
  };
  await page.locator(`[data-ai-object="${person}"]`).click();
  await page.locator('[data-ai-object-section="memory"]').click();
  assert.deepEqual(await page.locator('.ai-reference-memory-categories button span').allTextContents(), ['姓名','其他记忆','工作信息','日期','地址','手机号码','学校']);
  await add('name','name','王小明');
  await add('name','addressing','小王');
  await category('school');
  const school = await add('school','school','龙海一中');
  assert.equal(await school.locator('.ai-wiki-school-name').count(), 0);
  const degree = school.locator('[aria-label="学历"]');
  assert.deepEqual(await degree.locator('option').allTextContents(), ['未选择学历', '小学', '初中', '高中', '中专', '职高', '技校', '大专', '本科', '硕士研究生', '博士研究生']);
  await degree.selectOption('本科');
  const schoolBoxes = await school.evaluate(node => ({ text: node.querySelector('[aria-label="信息内容"]').getBoundingClientRect(), degree: node.querySelector('[aria-label="学历"]').getBoundingClientRect() }));
  assert.ok(Math.abs(schoolBoxes.text.top - schoolBoxes.degree.top) < 2);
  await category('date_info'); await add('date_info','birthday','农历正月初八'); await add('date_info','date','结婚纪念日');
  await category('address'); await add('address','household','漳州'); await add('address','residence','厦门'); await add('address','shipping','厦门软件园');
  const output = path.join(root, process.argv[2] || 'reports/memory-redesign'); await mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'person-address.png') });
  await save();
  const personProfile = ai.profiles().find(profile => profile.contact === person);
  assert.deepEqual(readMemory(ai.vault, ai.data.profiles[personProfile.id]).entries.map(entry => entry.field).sort(), ['addressing','birthday','date','household','name','residence','school','shipping'].sort());
  assert.equal(readMemory(ai.vault, ai.data.profiles[personProfile.id]).entries.find(entry => entry.field === 'school')?.degree, '本科');
  await page.locator('[data-ai-kind="group"]').click(); await page.locator(`[data-ai-object="${group.id}"]`).click();
  await page.locator('[data-ai-object-section="memory"]').click();
  assert.deepEqual(await page.locator('.ai-reference-memory-categories button span').allTextContents(), ['群概况','群内约定','共同事项','成员与分工','话题与偏好','重要活动','其他记忆']);
  await category('group_member'); await add('group_member','group_member','小李负责对接场地');
  await category('group_plan'); await add('group_plan','group_plan','周六一起布置场地');
  await page.screenshot({ path: path.join(output, 'group-plan.png') });
  await save();
  const groupProfile = ai.profiles().find(profile => profile.contact === group.id);
  assert.deepEqual(readMemory(ai.vault, ai.data.profiles[groupProfile.id]).entries.map(entry => entry.field).sort(), ['group_member','group_plan']);
  assert.deepEqual(errors, []);
  console.log(`聊天记忆单聊与群聊浏览器检查通过：${output}`);
} finally {
  await browser?.close(); await app.close(); await peer.close(); await cleanup(dataRoot);
}
