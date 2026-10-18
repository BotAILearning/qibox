import test from 'node:test';
import assert from 'node:assert/strict';
import { preparationMarkup } from '../web/preparation-view.mjs';

const base = {
  status: 'idle', stage: 'checking', bytes: 0, total: 128 * 1024 * 1024, remaining: 64 * 1024 * 1024,
  architecture: 'x64', details: { reusedFiles: 12, missingResources: 3 },
};

test('local preparation explains bundled resources and has no component download or fake progress UI', () => {
  const html = preparationMarkup(base, { installed: null, downloadSize: 90 * 1024 * 1024, remainingDownloadSize: 30 * 1024 * 1024 });
  assert.match(html, /运行环境随栖盒安装包提供/);
  assert.match(html, /<details class="preparation-details"><summary>查看资源校验与恢复详情/);
  assert.match(html, /待修复资源量估算/);
  assert.match(html, /64\.0 MB/);
  assert.match(html, /已复用系统文件/);
  assert.match(html, /资源量是本地资源检查结果，不表示准备进度或自检结论/);
  assert.match(html, /当前剩余下载量 <strong>30\.0 MB/);
  assert.match(html, /data-preparation="offline"/);
  assert.match(html, /关闭页面不会中断/);
  assert.doesNotMatch(html, /<progress|data-preparation="pause"|暂停|资源来源|正式网络源|下载运行环境|运行组件.*下载/);
});

test('working state reports the real stage without percentage progress and importing disables actions', () => {
  const html = preparationMarkup({ ...base, status: 'working', stage: 'verifying', bytes: 5, remaining: 7, total: 12 }, {}, { importing: true });
  assert.match(html, /校验随包资源/);
  assert.match(html, /后台运行，关闭页面后会继续/);
  assert.match(html, /正在导入并校验离线环境包/);
  assert.match(html, /data-preparation="offline" disabled/);
  assert.doesNotMatch(html, /<progress|%|data-preparation="pause"|暂停/);
});

test('failed preparation and failed import preserve escaped recovery guidance', () => {
  const html = preparationMarkup({ ...base, status: 'error', stage: 'selftest', error: '自检失败 <retry>' }, {}, { importError: 'archive <bad>' });
  assert.match(html, /准备未完成，可修复后重试/);
  assert.match(html, /自检失败 &lt;retry&gt;/);
  assert.match(html, /离线环境包导入失败：archive &lt;bad&gt;/);
  assert.match(html, /原有数据和环境保持不变/);
  assert.match(html, /data-preparation="start"/);
  assert.match(html, /重试准备/);
});

test('restarting an interrupted local preparation does not promise checkpoint continuation', () => {
  const html = preparationMarkup({ ...base, status: 'paused', stage: 'verifying' }, {});
  assert.match(html, /本机准备待继续/);
  assert.match(html, /会重新检查/);
  assert.match(html, /随包资源和当前运行环境会保留/);
  assert.match(html, /继续本机准备/);
  assert.doesNotMatch(html, /暂停|断点|检查点|从已校验的位置/);
});

test('ready runtime remains visible when the official client is absent and reuses an installed client', () => {
  const waiting = preparationMarkup({ ...base, status: 'ready', stage: 'ready', remaining: 0 }, { installed: null, remainingDownloadSize: 0, downloadSize: 90 });
  assert.match(waiting, /运行环境已就绪/);
  assert.match(waiting, /官方微信客户端/);
  assert.match(waiting, /当前剩余下载量 <strong>0 字节/);
  assert.match(waiting, /data-preparation="offline"/);

  assert.equal(preparationMarkup({ ...base, status: 'ready' }, { installed: { version: '4.1' } }), '');
});

test('unknown official client size is not presented as a fabricated estimate', () => {
  const html = preparationMarkup(base, { installed: null, downloadSize: null, remainingDownloadSize: null });
  assert.match(html, /选择官方客户端版本后显示实际下载量/);
  assert.doesNotMatch(html, /当前剩余下载量 <strong>/);
});
