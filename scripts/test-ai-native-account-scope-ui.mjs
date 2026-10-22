// Real local browser + production app/API; synthetic accounts only.
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { root, playwrightPath } from './tooling.mjs';
import { proactiveFixture } from './proactive-ui-fixture.mjs';
import { key } from '../test/ai-fixtures.mjs';
const { chromium } = createRequire(import.meta.url)(playwrightPath);
const out = path.resolve(root, process.env.QIBOX_TEST_OUTPUT || 'reports/ai-native-account-scope');
await fs.mkdir(out, { recursive: false });
const sourceFiles = ['config/product.json','package.json','server/ai-account-scope.mjs','server/ai-service.mjs','server/index.mjs','server/ai-account-configuration.mjs','server/ai-object-configuration.mjs','server/ai-configuration-commit.mjs','web/ai-assistant.mjs','public/app.js',
  ...(await fs.readdir(path.join(root,'public/chunks'))).filter(name=>name.endsWith('.js')).map(name=>'public/chunks/'+name)];
const hashes = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,createHash('sha256').update(await fs.readFile(path.join(root,name))).digest('hex')])));
const proof = { at: new Date().toISOString(), scope: 'Actual Edge with disposable production application/API; synthetic native identity changes and delayed HTTP response; no real account, model or message', passed: false, cases: [], realModelRequests: 0, realWechatSends: 0, mockGenerationRequests: 0, sourceHashesBefore: await hashes() };
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  for (const width of [1280,375]) for (const theme of ['light','dark']) {
    const fixture = await proactiveFixture(), { ai, bridge, provider } = fixture;
    const name = `${width}-${theme}`, row = { name, width, theme, checks: {}, screenshots: [], pageErrors: [], passed: false }; proof.cases.push(row);
    const context = await browser.newContext({ viewport: { width, height: 900 }, colorScheme: theme });
    const page = await context.newPage(); page.setDefaultTimeout(12000);
    page.on('pageerror', error=>row.pageErrors.push(error.message));
    const screen = async phase => { const name = `${row.name}-${phase}.png`; await page.waitForTimeout(220); await page.screenshot({ path: path.join(out,name) }); row.screenshots.push(name); };
    let releaseScan = () => {}, releaseIdentity = () => {};
    try {
      const contact = bridge.contacts[0].id, marker = `PRIVATE_DRAFT_017_${width}_${theme}`;
      bridge.contacts[0].label = 'OLD_PRIVATE_CONTACT_017'; await ai.scan();
      await ai.saveReplyProfile({ contact, style: { summary: '自然简短' }, strategy: { replyGoal: '准确回应', boundaries: '已保存旧边界' } });
      const originalIdentity = bridge.currentAccount.bind(bridge);
      await page.goto(fixture.url);
      if (width < 640) { await page.locator('[data-mobile-ai-open]').click(); row.checks.actualMobileSettingsEntry = true; }
      else { await page.locator('[data-action=open]').click(); await page.locator('#ai-open').click(); }
      await page.locator(`[data-ai-object="${contact}"]`).click();
      const boundaries = () => page.locator('#ai-object-form [name=boundaries]');
      await page.locator('#ai-object-form details').filter({ hasText: '回复策略' }).locator('summary').click();
      await boundaries().fill(marker);
      if (width >= 640) {
        await page.keyboard.press('Escape'); await page.locator('#ai-panel').waitFor({ state:'hidden' });
        const identityEntered = Promise.withResolvers(), identityRelease = Promise.withResolvers();
        releaseIdentity = () => identityRelease.reject(Error('synthetic identity unavailable'));
        bridge.currentAccount = async () => { identityEntered.resolve(); return identityRelease.promise; };
        await page.locator('#ai-open').click(); await identityEntered.promise;
        await page.locator('#ai-content .ai-entry-loading').waitFor({state:'visible'});
        assert.equal(await boundaries().count(),0); assert.equal((await page.locator('#ai-content').innerText()).includes('OLD_PRIVATE_CONTACT_017'),false);
        row.checks.oldCacheHiddenBeforeIdentity = true; await screen('opening-before-identity'); releaseIdentity();
      } else {
        // A phone's real return action disconnects this workspace. Exercise a
        // temporary unknown identity in place, so its same-account draft is
        // retained rather than testing a deliberate full workspace exit.
        bridge.currentAccount = async () => { throw Error('synthetic mobile identity unavailable'); };
        await page.locator('#ai-content .ai-entry-loading').waitFor({state:'visible'});
        row.checks.mobileIdentityFailureConcealsFields = true;
      }
      await page.waitForFunction(()=>document.querySelector('#ai-feedback')?.getAttribute('role')==='alert');
      assert.equal(await boundaries().count(),0); assert.equal((await page.locator('#ai-feedback').innerText()).includes('确认当前微信账号'),true);
      const back = page.locator(width<640?'#ai-mobile-back':'#ai-close'); assert.equal(await back.isVisible(),true);
      row.checks.unknownIdentityShowsErrorAndReturn = true; await screen('unknown-identity');
      if (width >= 640) { await back.click(); await page.locator('#ai-panel').waitFor({state:'hidden'}); }
      bridge.currentAccount = originalIdentity;
      if (width >= 640) await page.locator('#ai-open').click();
      await boundaries().waitFor({state:'attached'});
      assert.equal(await boundaries().inputValue(),marker); row.checks.sameAccountDraftRecovered = true; await screen('same-account-draft-recovered');

      // A slow scan is a real controller workflow (busy=true), but its response
      // is held after the backend finished. Identity fails during that wait.
      if (width < 640) await page.locator('#ai-mobile-back').click();
      const scanEntered = Promise.withResolvers(), scanRelease = Promise.withResolvers(); releaseScan = () => scanRelease.resolve();
      let scanPosts = 0;
      await page.route(`**/instances/${fixture.instance.id}/ai**`, async route => {
        const request = route.request();
        if (request.method()==='POST' && request.postDataJSON()?.action==='scan') {
          scanPosts++; const response = await route.fetch(); scanEntered.resolve(); await scanRelease.promise; return route.fulfill({response});
        }
        return route.continue();
      });
      await page.locator('[data-ai-action=scan]').first().click(); await scanEntered.promise;
      bridge.currentAccount = async () => { throw Error('synthetic busy identity unavailable'); };
      await page.locator('#ai-content .ai-entry-loading').waitFor({state:'visible'});
      assert.equal((await page.locator('#ai-content').innerText()).includes('OLD_PRIVATE_CONTACT_017'),false);
      assert.equal(await boundaries().count(),0); row.checks.busyIdentityFailureConcealsOldContent = true; await screen('busy-identity-failure');
      releaseScan(); await page.waitForTimeout(500);
      assert.equal((await page.locator('#ai-content').innerText()).includes('OLD_PRIVATE_CONTACT_017'),false);
      assert.equal(scanPosts,1); row.checks.lateOldActionCannotUncoverContentOrRepeatScan = true; await screen('late-action-remains-concealed');
      bridge.currentAccount = originalIdentity;
      await page.locator(`[data-ai-object="${contact}"]`).waitFor({state:'visible'});
      await page.locator(`[data-ai-object="${contact}"]`).click();
      assert.equal(await boundaries().inputValue(),marker); row.checks.busySameAccountDraftRecovered = true;

      if (width >= 640) { await page.locator('#ai-close').click(); await page.locator('#ai-panel').waitFor({state:'hidden'}); }
      bridge.account = key(`native-account-017-${name}`);
      bridge.contacts = [{id:contact,label:'NEW_ACCOUNT_CONTACT_017',kind:'person'}];
      if (width >= 640) await page.locator('#ai-open').click();
      await page.getByRole('button',{name:/NEW_ACCOUNT_CONTACT_017/}).waitFor({state:'visible'});
      await page.locator(`[data-ai-object="${contact}"]`).click();
      assert.notEqual(await boundaries().inputValue(),marker);
      assert.equal((await page.locator('#ai-content').innerText()).includes('OLD_PRIVATE_CONTACT_017'),false);
      assert.equal(ai.data.account,bridge.account); assert.equal(ai.data.settings.enabled,false);
      row.checks.actualIdentitySwitchWithoutManualScanDropsOldDraft = true; await screen('new-account-old-draft-removed');
      if (width < 640) {
        await page.locator('#ai-mobile-back').click(); await page.locator('#ai-mobile-back').click();
        await page.locator('#ai-panel').waitFor({state:'hidden'}); await page.locator('[data-mobile-ai-open]').waitFor({state:'visible'});
        row.checks.actualMobileReturnWorked = true;
      }
      assert.equal(provider.calls.length,0); assert.equal(bridge.sent.length,0); assert.deepEqual(row.pageErrors,[]);
      row.passed = true;
    } finally {
      releaseScan(); releaseIdentity();
      proof.mockGenerationRequests += provider.calls.length;
      await context.close(); await fixture.close();
      await fs.writeFile(path.join(out,'progress.json'),JSON.stringify(proof,null,2)+'\n');
    }
  }
  proof.passed = proof.cases.every(row=>row.passed);
} finally {
  proof.sourceHashesAfter = await hashes(); proof.sourceUnchanged = JSON.stringify(proof.sourceHashesBefore)===JSON.stringify(proof.sourceHashesAfter);
  await fs.writeFile(path.join(out,'report.json'),JSON.stringify(proof,null,2)+'\n',{flag:'wx'});
  await browser.close();
}
console.log(JSON.stringify({passed:proof.passed,cases:proof.cases.length,realModelRequests:proof.realModelRequests,realWechatSends:proof.realWechatSends,sourceUnchanged:proof.sourceUnchanged}));
