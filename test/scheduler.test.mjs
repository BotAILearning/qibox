import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WechatScheduler, scheduleWindow } from '../server/scheduler.mjs';
import { temp, cleanup } from './fixtures.mjs';

test('idle saves and runs without inspecting eligibility, including legacy profiles', async () => {
  const root = await temp(); let starts = 0, stops = 0, now = new Date('2026-09-10T18:00:00Z');
  const runtime = { status: 'stopped', inspectAutoLogin() { assert.fail('No eligibility detection'); } };
  const options = { dataRoot: root, runtime, ready: () => true, now: () => now,
    start: async () => { starts++; runtime.status = 'running'; }, stop: async () => { stops++; runtime.status = 'stopped'; } };
  const scheduler = new WechatScheduler(options);
  try {
    await writeFile(scheduler.file, JSON.stringify({ mode: 'idle', startTime: '02:00', endTime: '02:30', autoLoginReady: false }));
    await scheduler.init();
    assert.equal('autoLoginReady' in JSON.parse(await readFile(scheduler.file)), false);
    assert.equal(scheduler.publicState().idleAvailable, true);
    await scheduler.save({ mode: 'idle', startTime: '02:00', endTime: '02:30', idleAvailable: false });
    await scheduler.tick(); assert.equal(starts, 1);
    now = new Date('2026-09-10T18:30:00Z'); await scheduler.tick(); assert.equal(stops, 1);
  } finally { await scheduler.close(); await cleanup(root); }
});

test('scheduled idle waits for the login page, clicks once and stops trying after takeover or timeout', async () => {
  for (const end of ['clicked', 'takeover', 'timeout', 'logged-in', 'failure', 'continuous']) {
    const root = await temp(); let now = new Date('2026-09-10T18:00:00Z'), attempts = 0;
    const runtime = { status: 'stopped', confirmScheduledLogin: async () => {
      attempts++;
      if (end === 'failure') throw new Error('inaccessible');
      return attempts > 1 && end === 'clicked' ? { status: 'logged-out', clicked: true } : { status: end === 'logged-in' ? 'logged-in' : 'unknown' };
    } };
    const scheduler = new WechatScheduler({ dataRoot: root, runtime, ready: () => true, now: () => now,
      start: async () => { runtime.status = 'running'; }, stop: async () => { runtime.status = 'stopped'; } });
    try {
      await scheduler.init(); await scheduler.save({ mode: end === 'continuous' ? 'continuous' : 'idle', startTime: '02:00', endTime: '03:00' });
      await scheduler.tick();
      assert.equal(attempts, end === 'continuous' ? 0 : 1);
      if (end === 'takeover') await scheduler.interact();
      now = new Date(+now + (end === 'timeout' || end === 'failure' ? 120000 : 30000));
      await scheduler.tick(); await scheduler.tick();
      assert.equal(attempts, end === 'continuous' ? 0 : end === 'clicked' ? 2 : end === 'takeover' || end === 'timeout' || end === 'failure' || end === 'logged-in' ? 1 : 3);
      assert.equal(runtime.status, 'running');
    } finally { await scheduler.close(); await cleanup(root); }
  }
});
test('manual default, explicit continuous mode, persistent pause and reopening retain original rules', async () => {
  const root = await temp(); let starts = 0;
  const runtime = { status: 'stopped' }; const options = { dataRoot: root, runtime, ready: () => true, start: async () => { starts++; runtime.status = 'running'; }, stop: async () => { runtime.status = 'stopped'; } };
  const scheduler = new WechatScheduler(options);
  try {
    await scheduler.init(); await scheduler.tick(); assert.equal(starts, 0);
    await scheduler.save({ mode: 'continuous', startTime: '02:00', endTime: '02:30' }); await scheduler.tick(); assert.equal(starts, 1);
    await scheduler.pause(); runtime.status = 'stopped'; await scheduler.tick(); assert.equal(starts, 1);
    const reboot = new WechatScheduler(options); await reboot.init(); await reboot.tick(); assert.equal(starts, 1);
    await reboot.interact(); await options.start(); assert.equal(starts, 2);
    await reboot.save({ mode: 'idle', startTime: '02:00', endTime: '02:30' });
    assert.equal(reboot.settings.mode, 'idle');
  } finally { await scheduler.close(); await cleanup(root); }
});

test('idle follows a cross-midnight window and never stops a session the user has opened', async () => {
  const root = await temp(); let now = new Date('2026-09-10T14:59:00Z'), starts = 0, stops = 0;
  const runtime = { status: 'stopped', inspectAutoLogin: async () => ({ status: 'ready' }) };
  const scheduler = new WechatScheduler({ dataRoot: root, runtime, ready: () => true, now: () => now,
    start: async () => { starts++; runtime.status = 'running'; }, stop: async () => { stops++; runtime.status = 'stopped'; } });
  try {
    await scheduler.init(); await scheduler.save({ mode: 'idle', startTime: '23:00', endTime: '06:00' });
    await scheduler.tick(); assert.equal(starts, 0);
    now = new Date('2026-09-10T15:00:00Z'); await scheduler.tick(); assert.equal(starts, 1);
    now = new Date('2026-09-10T22:00:00Z'); await scheduler.tick(); assert.equal(stops, 1);
    now = new Date('2026-09-11T15:00:00Z'); await scheduler.tick(); assert.equal(starts, 2);
    await scheduler.interact(); now = new Date('2026-09-11T22:00:00Z'); await scheduler.tick(); assert.equal(stops, 1);
    const setting = scheduler.settings;
    assert.equal(scheduleWindow(setting, new Date('2026-09-10T16:01:00Z')).key, '2026-09-10:23:00');
    assert.equal(scheduleWindow(setting, new Date('2026-09-10T22:00:00Z')).active, false);
  } finally { await scheduler.close(); await cleanup(root); }
});
test('failed startup attempts obey 60-second backoff and three failures per day', async () => {
  const root = await temp(); let now = new Date('2026-09-10T03:00:00Z'), attempts = 0;
  const scheduler = new WechatScheduler({ dataRoot: root, runtime: { status: 'stopped' }, ready: () => true, now: () => now, start: async () => { attempts++; throw new Error('offline'); }, stop: async () => {} });
  try {
    await scheduler.init(); await scheduler.save({ mode: 'continuous', startTime: '02:00', endTime: '02:30' });
    await scheduler.tick(); await scheduler.tick(); assert.equal(attempts, 1);
    for (let i = 0; i < 4; i++) { now = new Date(+now + 61000); await scheduler.tick(); }
    assert.equal(attempts, 3); now = new Date(+now + 86400000); await scheduler.tick(); assert.equal(attempts, 4);
  } finally { await scheduler.close(); await cleanup(root); }
});

test('not ready instances never start', async () => {
  const root = await temp(); let ready = false, starts = 0;
  const scheduler = new WechatScheduler({ dataRoot: root, runtime: { status: 'stopped' }, ready: () => ready, start: async () => { starts++; }, stop: async () => {} });
  try { await scheduler.init(); await scheduler.save({ mode: 'continuous', startTime: '02:00', endTime: '02:30' }); await scheduler.tick(); assert.equal(starts, 0); ready = true; await scheduler.tick(); assert.equal(starts, 1); }
  finally { await scheduler.close(); await cleanup(root); }
});
