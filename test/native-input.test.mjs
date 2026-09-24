import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeInput } from '../web/native-input.mjs';

class Element extends EventTarget {
  value = ''; hidden = true; style = {}; classes = new Set();
  classList = { add: name => this.classes.add(name), remove: name => this.classes.delete(name) };
  focus() { this.focused = true; }
  getBoundingClientRect() { return { left: 10, top: 20, width: 1000, height: 600 }; }
}
function fire(target, type, data = {}) {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(data)) Object.defineProperty(event, key, { value });
  target.dispatchEvent(event); return event;
}
function setup(options = {}) {
  const input = new Element(), screen = new Element(), keys = [], pasted = [], errors = [];
  const client = { sendKey: (...args) => keys.push(args) };
  const bridge = nativeInput({ input, screen, client, paste: async text => pasted.push(text), notify: text => errors.push(text), ...options });
  return { input, screen, keys, pasted, errors, client, bridge };
}

test('failed Unicode paste retains queued text and blocks Enter until explicit recovery', async () => {
  const recovered = [], fixture = setup({ paste: async () => { throw new Error('offline'); }, recover: text => recovered.push(text) });
  fire(fixture.input, 'compositionend', { data: '中文🙂' });
  fire(fixture.input, 'keydown', { key: 'Enter' });
  await fixture.bridge.flush(); assert.deepEqual(fixture.keys, []); assert.deepEqual(recovered, ['中文🙂']);
  fixture.bridge.resume(); fire(fixture.input, 'input', { data: 'abc' }); await fixture.bridge.flush();
  assert.deepEqual(fixture.keys, [[97], [98], [99]]); fixture.bridge.dispose();
});

test('disconnect during composition retains the visible text without submitting it', () => {
  const recovered = [], fixture = setup({ recover: text => recovered.push(text) });
  fire(fixture.input, 'compositionstart'); fixture.input.value = '尚未确认'; fixture.bridge.dispose();
  assert.deepEqual(recovered, ['尚未确认']); assert.deepEqual(fixture.keys, []);
});

test('dispose preserves a recovered draft when the default recovery callback uses the input itself', () => {
  const input = new Element(), screen = new Element(), client = { sendKey() {} };
  const bridge = nativeInput({ input, screen, client, paste: async () => {}, notify() {} });
  fire(input, 'compositionstart'); input.value = '尚未确认'; bridge.dispose();
  assert.equal(input.value, '尚未确认'); assert.equal(input.hidden, true);
});

test('cancelled composition is retained for review and never reaches the remote keyboard', async () => {
  const recovered = [], fixture = setup({ recover: text => recovered.push(text) });
  fire(fixture.input, 'compositionstart'); fixture.input.value = 'nihao';
  fire(fixture.input, 'compositionend', { data: '' });
  fire(fixture.input, 'input', { data: 'nihao', inputType: 'insertCompositionText' });
  await fixture.bridge.flush();
  assert.deepEqual(fixture.pasted, []); assert.deepEqual(fixture.keys, []);
  assert.deepEqual(recovered, ['nihao']); fixture.bridge.dispose();
});

test('blur retains unfinished composition for recovery instead of clearing the recovered draft', () => {
  const { input, bridge, keys } = setup(); fire(input, 'compositionstart'); input.value = '尚未确认'; fire(input, 'blur');
  assert.equal(input.value, '尚未确认'); assert.ok(input.classes.has('composing')); assert.deepEqual(keys, []); bridge.dispose();
});

test('Chinese composition sends committed text once for each browser final-input ordering', async () => {
  for (const order of ['before', 'insertText', 'insertCompositionText', 'insertFromComposition']) {
    const { input, keys, pasted, bridge } = setup();
    fire(input, 'compositionstart'); input.value = 'nihao';
    fire(input, 'input', { data: 'nihao', isComposing: true });
    fire(input, 'keydown', { key: 'Enter', isComposing: true });
    if (order === 'before') fire(input, 'input', { data: '你好', inputType: 'insertText' });
    fire(input, 'compositionend', { data: '你好' });
    if (order !== 'before') fire(input, 'input', { data: '你好', inputType: order });
    await bridge.flush();
    assert.deepEqual(pasted, ['你好'], order); assert.deepEqual(keys, [[0xffe3, 'ControlLeft', true], [0x76], [0xffe3, 'ControlLeft', false]], order);
    assert.equal(input.value, ''); assert.equal(input.classes.has('composing'), false);
    bridge.dispose();
  }
});

test('host switching shortcuts and dead keys stay local, then English and emoji still commit', async () => {
  const { input, keys, pasted, bridge } = setup();
  for (const props of [{ key: 'Shift', altKey: true }, { key: ' ', code: 'Space', ctrlKey: true }, { key: ' ', code: 'Space', metaKey: true }, { key: 'Dead' }, { key: '@', getModifierState: name => name === 'AltGraph' }]) {
    assert.equal(fire(input, 'keydown', props).defaultPrevented, false);
  }
  fire(input, 'compositionstart'); fire(input, 'compositionend', { data: '' });
  fire(input, 'keydown', { key: 'A' }); input.value = 'Aé😀'; fire(input, 'input', { inputType: 'insertText', data: 'Aé😀' });
  await bridge.flush(); assert.deepEqual(pasted, ['Aé😀']);
  bridge.dispose();
});

test('trailing composition input does not swallow a later equal committed string', async () => {
  const { input, keys, pasted, bridge } = setup();
  fire(input, 'compositionstart'); fire(input, 'compositionend', { data: '好' });
  fire(input, 'input', { data: '好', inputType: 'insertText' });
  input.value = '好'; fire(input, 'input', { data: '好', inputType: 'insertText' });
  await bridge.flush(); assert.deepEqual(pasted, ['好', '好']); bridge.dispose();
});

test('composition anchor stays inside the desktop and does not move during composition', () => {
  const { input, screen, bridge, client } = setup();
  fire(screen, 'mousedown', { button: 0, clientX: 1009, clientY: 619 });
  assert.equal(input.style.left, '750px'); assert.equal(input.style.top, '564px');
  fire(input, 'compositionstart');
  fire(screen, 'mousedown', { button: 0, clientX: 300, clientY: 300 });
  assert.equal(input.style.left, '750px'); assert.equal(input.style.top, '564px');
  assert.equal(client.focusOnClick, false);
  fire(input, 'compositionend', { data: '' });
  fire(screen, 'mousedown', { button: 0, clientX: -10, clientY: -10 });
  assert.equal(input.style.left, '0px'); assert.equal(input.style.top, '0px'); bridge.dispose();
});

test('paste completes before later keys or clicks change the remote field', async () => {
  let release; const received = [], ready = new Promise(resolve => { release = resolve; });
  const { input, screen, keys, bridge } = setup({ paste: async text => { received.push(text); await ready; } });
  fire(input, 'paste', { clipboardData: { getData: () => '第一行\n第二行' } });
  assert.equal(fire(screen, 'mousedown', { button: 0 }).defaultPrevented, true);
  fire(input, 'keydown', { key: 'Enter' });
  await Promise.resolve(); assert.deepEqual(keys, []); release(); await bridge.flush();
  assert.deepEqual(received, ['第一行\n第二行']);
  assert.deepEqual(keys, [[0xffe3, 'ControlLeft', true], [0x76], [0xffe3, 'ControlLeft', false], [0xff0d]]);
  bridge.dispose();
});

test('each clipboard owner becomes ready before its matching RFB paste chord and the next clipboard', async () => {
  const order = [];
  const input = new Element(), screen = new Element();
  const client = { sendKey: key => { if (key === 0x76) order.push('rfb:paste'); } };
  const bridge = nativeInput({ input, screen, client, paste: async text => { order.push(`ready:${text}`); }, notify() {} });
  fire(input, 'compositionend', { data: '第一份🙂' });
  await bridge.flush();
  fire(input, 'compositionstart'); fire(input, 'compositionend', { data: '第二份🙂' });
  await bridge.flush();
  assert.deepEqual(order, ['ready:第一份🙂', 'rfb:paste', 'ready:第二份🙂', 'rfb:paste']);
  bridge.dispose();
});

test('disconnect clears composition, removes handlers and cancels unsent input', async () => {
  const { input, keys, pasted, bridge } = setup();
  fire(input, 'compositionstart'); fire(input, 'compositionend', { data: '你好' });
  bridge.dispose(); await bridge.flush();
  assert.deepEqual(keys, []); assert.equal(input.hidden, true); assert.equal(input.value, '你好');
  fire(input, 'input', { data: 'x' }); await bridge.flush(); assert.deepEqual(keys, []);
});

test('image and file paste waits for ownership, prefers files over text, and never presses send',async()=>{
 const ready=Promise.withResolvers(),received=[],files=[{name:'截图.png',type:'image/png'}];
 const {input,screen,keys,bridge,pasted}=setup({pasteFiles:async value=>{received.push(value);await ready.promise;}});
 fire(input,'paste',{clipboardData:{files,getData:()=> 'must not replace image'}});
 assert.equal(fire(screen,'mousedown',{button:0}).defaultPrevented,true);
 await Promise.resolve();assert.deepEqual(keys,[]);ready.resolve();await bridge.flush();
 assert.deepEqual(received,[files]);assert.deepEqual(pasted,[]);
 assert.deepEqual(keys,[[0xffe3,'ControlLeft',true],[0x76],[0xffe3,'ControlLeft',false]]);bridge.dispose();
});

test('failed file paste never sends a paste chord and can recover without a stuck pointer block',async()=>{
 const {input,screen,keys,bridge}=setup({pasteFiles:async()=>{throw Error('failure');}});
 fire(input,'paste',{clipboardData:{files:[{}]}});await bridge.flush();assert.deepEqual(keys,[]);
 bridge.resume();assert.equal(fire(screen,'mousedown',{button:0,clientX:30,clientY:40}).defaultPrevented,false);bridge.dispose();
});
