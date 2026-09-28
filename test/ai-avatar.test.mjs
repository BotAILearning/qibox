import test from 'node:test';
import assert from 'node:assert/strict';
import { readWechatAvatar, safeAvatarUrl } from '../server/ai-avatar.mjs';
import { contactPickerAvatar, noteContactAvatarFailure, resetContactAvatarFailures, setContactAvatarInstance } from '../web/ai-contact-picker.mjs';

const instance = '11111111-1111-4111-8111-111111111111';
const id = 'a'.repeat(64);

test('avatar sources are limited to WeChat hosts and upgraded to HTTPS', () => {
  assert.equal(safeAvatarUrl('http://wx.qlogo.cn/mmhead/example/0'), 'https://wx.qlogo.cn/mmhead/example/0');
  assert.equal(safeAvatarUrl('https://mmhead.c2c.wechat.com/picture'), 'https://mmhead.c2c.wechat.com/picture');
  for (const url of ['https://wx.qlogo.cn.evil.test/picture', 'https://127.0.0.1/picture', 'file:///etc/passwd', 'https://user@wx.qlogo.cn/picture']) assert.equal(safeAvatarUrl(url), null);
});

test('avatar relay accepts a small real image and rejects redirects outside WeChat', async () => {
  const jpeg = Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]);
  const image = await readWechatAvatar('https://wx.qlogo.cn/avatar', { fetcher: async () => new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(image.mime, 'image/jpeg'); assert.deepEqual(image.bytes, Buffer.from(jpeg));
  const redirected = await readWechatAvatar('https://wx.qlogo.cn/avatar', { fetcher: async () => new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/private' } }) });
  assert.equal(redirected, null);
  const invalid = await readWechatAvatar('https://wx.qlogo.cn/avatar', { fetcher: async () => new Response('not an image', { headers: { 'content-type': 'image/jpeg' } }) });
  assert.equal(invalid, null);
});

test('contact avatar uses the transient image endpoint and the default graphic on failure', () => {
  setContactAvatarInstance(instance); resetContactAvatarFailures();
  const contact = { id, label: '联系人', avatar: true };
  const image = contactPickerAvatar(contact);
  assert.match(image, new RegExp(`/api/instances/${instance}/ai/avatar/${id}`));
  assert.match(image, /<svg /);
  const node = { dataset: { aiAvatar: `${instance}:${id}` }, remove() {} };
  assert.equal(noteContactAvatarFailure(node), true);
  assert.doesNotMatch(contactPickerAvatar(contact), /<img /);
  assert.doesNotMatch(contactPickerAvatar({ ...contact, avatar: false }), /<img /);
  setContactAvatarInstance(null);
});
