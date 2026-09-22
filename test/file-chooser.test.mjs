import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Readable, PassThrough } from 'node:stream';
import { readFile, readdir, access, writeFile, open } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { FileChooser, chatFilename, MAX_CHAT_FILE } from '../server/file-chooser.mjs';
import { temp, cleanup } from './fixtures.mjs';

async function setup(t, multiple = true) {
  const dataRoot = await temp(), sent = [], client = randomUUID(), id = randomUUID();
  const chooser = new FileChooser({ dataRoot, send: event => sent.push(event) });
  await chooser.init(); chooser.receive({ type: 'request', id, multiple }); chooser.claim(id, client);
  t.after(async () => { await chooser.close(); await cleanup(dataRoot); });
  return { chooser, sent, client, id };
}

test('NAS selection checks the owning user, copies pinned bytes and finishes only after staging', async t => {
  const { chooser, sent, client, id } = await setup(t), root = await temp(), file = root + '/中文资料.txt';
  t.after(() => cleanup(root)); await writeFile(file, 'NAS 内容'); const checked = [];
  const nas = { async openFile(uid, filename) { checked.push({ uid, filename }); const handle = await open(filename, 'r'); return { handle, info: await handle.stat() }; } };
  await chooser.prepareNas(id, client, [file], nas, '1001');
  assert.deepEqual(checked, [{ uid: '1001', filename: file }]); assert.equal(sent.length, 1); assert.equal(sent[0].response, 0);
  assert.equal(await readFile(fileURLToPath(sent[0].uris[0]), 'utf8'), 'NAS 内容');
});

test('denied NAS source cancels the selection without preparing an empty send', async t => {
  const { chooser, sent, client, id } = await setup(t);
  await assert.rejects(chooser.prepareNas(id, client, ['/private'], { openFile: async () => { throw new Error('denied'); } }, '1002'), /denied/);
  assert.deepEqual(sent, [{ id, response: 1 }]); assert.equal(chooser.state(client).request, null);
});
test('local files retain exact bytes, Unicode names, and separate duplicate filenames', async t => {
  const { chooser, sent, client, id } = await setup(t);
  const bytes = [Buffer.from('本机文件\n'), Buffer.from([0, 255, 23])];
  const plan = await chooser.plan(id, client, bytes.map(data => ({ name: '资料 #1.txt', size: data.length })));
  for (let i = 0; i < bytes.length; i++) await chooser.upload(id, client, plan.files[i].id, Readable.from(bytes[i]), bytes[i].length);
  assert.deepEqual(sent, []);
  await chooser.complete(id, client);
  assert.equal(sent.length, 1); assert.equal(sent[0].response, 0);
  assert.notEqual(sent[0].uris[0], sent[0].uris[1]);
  for (let i = 0; i < bytes.length; i++) assert.deepEqual(await readFile(fileURLToPath(sent[0].uris[i])), bytes[i]);
  assert.equal(chooser.state(client).request, null);
  await chooser.close();
  await access(fileURLToPath(sent[0].uris[0])); // Keep files until WeChat has finished using them.
});
test('paths, limits, unclaimed clients and obsolete requests are rejected', async t => {
  const { chooser, client, id } = await setup(t, false);
  for (const name of ['../secret', 'a/b', 'a\\b', '.', '..', 'a\0b', 'a\nb', 'x'.repeat(241)]) assert.throws(() => chatFilename(name));
  assert.equal(chooser.state(randomUUID()).request, null);
  assert.throws(() => chooser.claim(id, randomUUID()));
  await assert.rejects(chooser.plan(id, client, [{ name: 'a', size: 1 }, { name: 'b', size: 1 }]));
  await assert.rejects(chooser.plan(id, client, [{ name: 'a', size: MAX_CHAT_FILE + 1 }]));
  await assert.rejects(chooser.plan(randomUUID(), client, [{ name: 'a', size: 1 }]));
});
test('partial, oversized and failed uploads never return a file to WeChat', async t => {
  const { chooser, sent, client, id } = await setup(t);
  const plan = await chooser.plan(id, client, [{ name: 'short.txt', size: 3 }, { name: 'long.txt', size: 1 }]);
  await assert.rejects(chooser.upload(id, client, plan.files[0].id, Readable.from('a'), 3));
  await assert.rejects(chooser.upload(id, client, plan.files[1].id, Readable.from('ab'), 1));
  await assert.rejects(chooser.complete(id, client));
  assert.deepEqual(sent, []);
  await chooser.cancel(id, client);
  assert.equal(sent[0].response, 1);
  assert.deepEqual(await readdir(chooser.root), []);
});
test('cancelling an in-flight upload aborts it and removes only that request', async t => {
  const { chooser, sent, client, id } = await setup(t);
  const plan = await chooser.plan(id, client, [{ name: 'pending.txt', size: 100 }]);
  const stream = new PassThrough();
  const upload = chooser.upload(id, client, plan.files[0].id, stream, 100);
  const rejected = assert.rejects(upload);
  stream.write('a');
  await chooser.cancel(id, client); await rejected;
  assert.equal(sent[0].response, 1); assert.equal(chooser.state(client).request, null);
  assert.deepEqual(await readdir(chooser.root), []);
});
test('only one plan and one upload can own each request/file', async t => {
  const { chooser, client, id } = await setup(t);
  const first = chooser.plan(id, client, [{ name: 'a', size: 1 }]);
  await assert.rejects(chooser.plan(id, client, [{ name: 'b', size: 1 }]));
  const plan = await first;
  const stream = new PassThrough();
  const pending = chooser.upload(id, client, plan.files[0].id, stream, 1);
  await assert.rejects(chooser.upload(id, client, plan.files[0].id, Readable.from('x'), 1));
  stream.end('a'); await pending;
  await chooser.complete(id, client);
  await assert.rejects(chooser.complete(id, client));
});
test('another native request is cancelled without replacing the active selection', async t => {
  const { chooser, sent, client, id } = await setup(t);
  const other = randomUUID(); chooser.receive({ type: 'request', id: other, multiple: true });
  assert.deepEqual(sent, [{ id: other, response: 1 }]);
  assert.equal(chooser.state(client).request.id, id);
});
