import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FileChooser } from '../server/file-chooser.mjs';
import { temp, cleanup } from './fixtures.mjs';
async function setup(t) {
  const root = await temp(), home = path.join(root, 'profile'), dest = path.join(root, 'NAS');
  await mkdir(home); await mkdir(dest);
  const sent = [], chooser = new FileChooser({ dataRoot: root, home, send: x => sent.push(x) }); await chooser.init();
  t.after(async () => { await chooser.close(); await cleanup(root); });
  return { root, home, dest, chooser, sent, id: randomUUID(), client: randomUUID(), nas: { inDirectory: async (uid, directory, work) => { assert.equal(uid, '1000'); assert.equal(directory, dest); return work(dest); } } };
}
test('SaveFile waits for native completion then copies exact bytes into the authorized NAS folder', async t => {
  const { chooser, sent, id, client, nas, dest } = await setup(t);
  chooser.receive({ operation: 'save', id, name: '资料.txt' }); chooser.claim(id, client);
  await chooser.exports.start(id, client, '报告.txt');
  const file = fileURLToPath(sent[0].uris[0]); assert.equal(sent[0].watch, file);
  await writeFile(file, Buffer.from([0, 255, 7]));
  await assert.rejects(chooser.exports.download(id, client), /保存/);
  chooser.receive({ type: 'saved', id });
  const result = await chooser.exports.copyNas(id, client, dest, nas, '1000');
  assert.equal(result.saved[0].name, '报告.txt'); assert.deepEqual(await readFile(path.join(dest, '报告.txt')), Buffer.from([0, 255, 7]));
  assert.equal(chooser.state(client).request, null);
});
test('copy requests preserve originals, enforce client and instance isolation, and never overwrite', async t => {
  const { chooser, id, client, home, root, dest, nas } = await setup(t);
  const file = path.join(home, '资料.txt'); await writeFile(file, '内容');
  chooser.receive({ operation: 'copy', id, uris: [pathToFileURL(file).href] }); chooser.claim(id, client);
  assert.equal(chooser.state(randomUUID()).request, null);
  await assert.rejects(chooser.exports.download(id, randomUUID()), /结束/);
  const dl = await chooser.exports.download(id, client); assert.equal(await dl.handle.readFile('utf8'), '内容'); await dl.handle.close();
  await writeFile(path.join(dest, '资料.txt'), 'existing');
  await assert.rejects(chooser.exports.copyNas(id, client, dest, nas, '1000'), /同名/);
  assert.equal(await readFile(path.join(dest, '资料.txt'), 'utf8'), 'existing');
  await chooser.cancel(id, client); assert.equal(await readFile(file, 'utf8'), '内容');
  const other = path.join(root, 'private.txt'); await writeFile(other, 'private');
  chooser.receive({ operation: 'copy', id, uris: [pathToFileURL(other).href] }); chooser.claim(id, client);
  await assert.rejects(chooser.exports.download(id, client), /不属于/);
});
test('batch failure removes newly copied outputs but preserves existing destinations', async t => {
  const { chooser, id, client, home, dest, nas } = await setup(t);
  const uris = [];
  for (const name of ['a.txt', 'b.txt']) { const file = path.join(home, name); await writeFile(file, name); uris.push(pathToFileURL(file).href); }
  await writeFile(path.join(dest, 'b.txt'), 'existing');
  chooser.receive({ operation: 'copy', id, uris }); chooser.claim(id, client);
  await assert.rejects(chooser.exports.copyNas(id, client, dest, nas, '1000'), /同名/);
  assert.deepEqual(await readdir(dest), ['b.txt']);
});
test('folder request resolves the actual instance directory and concurrent upload cannot take ownership', async t => {
  const { chooser, id, client, home, sent } = await setup(t);
  const file = path.join(home, 'x.txt'); await writeFile(file, 'x');
  chooser.receive({ operation: 'folder', id, uris: [pathToFileURL(file).href] }); chooser.claim(id, client);
  assert.equal((await chooser.exports.folder(id, client)).path, home);
  const second = randomUUID(); chooser.receive({ type: 'request', id: second, multiple: false });
  assert.deepEqual(sent[0], { id: second, response: 1 }); assert.equal(chooser.state(client).request.id, id);
});
test('cancel during save preparation removes only the owned staging directory', async t => {
  const { chooser, id, client, home } = await setup(t);
  await writeFile(path.join(home, 'keep.txt'), 'keep');
  chooser.receive({ operation: 'save', id, name: 'a.txt' }); chooser.claim(id, client);
  const start = chooser.exports.start(id, client); const rejected = assert.rejects(start);
  await chooser.cancel(id, client); await rejected;
  assert.deepEqual(await readdir(chooser.exports.root), []); assert.equal(await readFile(path.join(home, 'keep.txt'), 'utf8'), 'keep');
});

test('Unicode clipboard text is transient, opaque in state and isolated to the claiming client', async t => {
  const { chooser, id, client } = await setup(t);
  const text = '中文🙂\r\n第二行 é';
  chooser.receive({ operation: 'copy', id, clipboardType: 'text', text });
  assert.equal(chooser.state(client).request.clipboardType, 'text');
  assert.equal(JSON.stringify(chooser.state(client)).includes(text), false);
  chooser.claim(id, client);
  await assert.rejects(chooser.exports.download(id, randomUUID()), /结束/);
  const file = await chooser.exports.download(id, client);
  const chunks = []; for await (const chunk of file.handle.createReadStream()) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), text);
  assert.deepEqual(await readdir(chooser.exports.clipboardRoot), []);
  await chooser.exports.finish(id, client); assert.equal(chooser.state(client).request, null);
});

test('a newer copy invalidates the old stream and old completion cannot clear the new copy', async t => {
  const { chooser, id, client } = await setup(t);
  chooser.receive({ operation: 'copy', id, clipboardType: 'text', text: 'old' }); chooser.claim(id, client);
  const previous = await chooser.exports.download(id, client), next = randomUUID();
  chooser.receive({ operation: 'copy', id: next, clipboardType: 'text', text: 'new' });
  assert.equal(previous.signal.aborted, true);
  await assert.rejects(chooser.exports.finish(id, client), /结束/);
  assert.equal(chooser.state(client).request.id, next);
});

test('only an exact owned image snapshot may be exported and cleanup preserves originals', async t => {
  const { chooser, id, client, home } = await setup(t);
  const original = path.join(home, 'original.png'); await writeFile(original, 'original');
  chooser.receive({ operation: 'copy', id, clipboardType: 'image', snapshot: true, uris: [pathToFileURL(original).href] });
  assert.equal(chooser.state(client).request, null);
  const image = path.join(chooser.exports.clipboardRoot, id + '.png'); await writeFile(image, 'png');
  chooser.receive({ operation: 'copy', id, clipboardType: 'image', snapshot: true, name: '微信图片.png', uris: [pathToFileURL(image).href] });
  chooser.claim(id, client); const downloaded = await chooser.exports.download(id, client);
  assert.equal(downloaded.name, '微信图片.png'); await downloaded.handle.close();
  await chooser.exports.finish(id, client);
  assert.deepEqual(await readdir(chooser.exports.clipboardRoot), []);
  assert.equal(await readFile(original, 'utf8'), 'original');
});

test('ordinary file copies are distinguished from images and local-input markers clear pending copies', async t => {
  const { chooser, id, client, home } = await setup(t);
  chooser.receive({ operation: 'copy', id, uris: [pathToFileURL(path.join(home, '资料.pdf')).href] });
  assert.equal(chooser.state(client).request.clipboardType, 'files');
  chooser.receive({ type: 'clipboard-clear' }); assert.equal(chooser.state(client).request, null);
  for (const text of ['', 'a\0b', '好'.repeat(20001)]) {
    chooser.receive({ operation: 'copy', id, clipboardType: 'text', text }); assert.equal(chooser.state(client).request, null);
  }
});
