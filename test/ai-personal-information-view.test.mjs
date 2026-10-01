import test from 'node:test';
import assert from 'node:assert/strict';
import { personalInformationPage, personalEntriesFromForm } from '../web/ai-account-settings.mjs';

const form = values => ({ querySelectorAll: () => values.map(({ field, text, allowGroup = false, shareChanged = false }) => ({
  dataset: { personalField: field, ...(shareChanged ? { personalShareChanged: 'true' } : {}) },
  querySelector: selector => selector === '[data-personal-input]' ? { value: text } : { checked: allowGroup },
})) });

test('saving an unrelated field keeps separate legacy entry identities and mixed group permissions', () => {
  const entries = [{ id: 'shared', field: 'city', text: '城市', allowGroup: true, expiresAt: 1 },
    { id: 'private', field: 'city', text: '私聊地点', allowGroup: false, expiresAt: 1 },
    { id: 'name', field: 'name', text: '旧姓名', allowGroup: false }];
  const result = personalEntriesFromForm(form([{ field: 'city', text: '城市\n私聊地点' }, { field: 'name', text: '新姓名' }]), { personalInformation: { entries } });
  assert.deepEqual(result.slice(0, 2), [{ id: 'shared', field: 'city', text: '城市', allowGroup: true }, { id: 'private', field: 'city', text: '私聊地点', allowGroup: false }]);
  assert.equal(result[2].id, 'name'); assert.equal(result[2].text, '新姓名');
  assert.equal(entries[0].expiresAt, 1, 'rendering and collecting do not mutate the loaded state');
});

test('an explicit group-permission change applies to the entire edited field and a mixed text edit stays private', () => {
  const state = { personalInformation: { entries: [{ id: 'a', field: 'city', text: '公开城市', allowGroup: true }, { id: 'b', field: 'city', text: '私聊地点', allowGroup: false }] } };
  const privateResult = personalEntriesFromForm(form([{ field: 'city', text: '公开城市\n私聊地点', shareChanged: true }]), state);
  assert.equal(privateResult.length, 1); assert.equal(privateResult[0].allowGroup, false);
  const edited = personalEntriesFromForm(form([{ field: 'city', text: '新城市' }]), state);
  assert.equal(edited[0].allowGroup, false);
  const shared = personalEntriesFromForm(form([{ field: 'city', text: '公开城市\n私聊地点', allowGroup: true, shareChanged: true }]), state);
  assert.equal(shared[0].allowGroup, true);
});

test('personal cards escape text and preserve multiline short-field values without adding expiry controls', () => {
  const text = '深圳\n<script>bad()</script>';
  const html = personalInformationPage({ account: 'a', personalInformation: { entries: [{ field: 'city', text, allowGroup: false }] } });
  assert.match(html, /<textarea[^>]*name="city"/);
  assert.match(html, /深圳\n&lt;script&gt;bad\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>|data-personal-expiry|type="date"/);
  assert.match(html, /更多信息/);
  assert.match(html, /data-state="filled"/);
});
