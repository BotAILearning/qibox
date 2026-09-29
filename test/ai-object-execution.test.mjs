import test from 'node:test';
import assert from 'node:assert/strict';
import { objectExecutionStatus } from '../web/ai-object-page-new.mjs';

const state = (live) => ({ profiles: [{ id: 'p1', contact: 'c1' }, { id: 'p2', contact: 'c2' }], settings: { enabled: true, reply: true }, live });

test('contact settings show only the selected contact live state and skip action', () => {
 const html = objectExecutionStatus(state([
  { id: 'p2', phase: 'generating' },
  { id: 'p1', phase: 'waiting', reason: '手动回复后的接续等待', dueAt: Date.now() + 60000 }
 ]), 'c1');
 assert.match(html, /手动回复后的接续等待/);
 assert.match(html, /data-ai-skip-reply-wait="p1"/);
 assert.doesNotMatch(html, /请求 AI/);
});
test('generating and non-skippable waits do not offer skip action', () => {
 assert.match(objectExecutionStatus(state([{ id: 'p1', phase: 'generating' }]), 'c1'), /请求 AI/);
 assert.doesNotMatch(objectExecutionStatus(state([{ id: 'p1', phase: 'generating' }]), 'c1'), /data-ai-skip-reply-wait/);
 assert.doesNotMatch(objectExecutionStatus(state([{ id: 'p1', phase: 'waiting', reason: '追问等待' }]), 'c1'), /data-ai-skip-reply-wait/);
});
test('enabled reply reports a temporary data outage instead of idle', () => {
 const html = objectExecutionStatus({ ...state([]), available: false, waiting: true, notice: '微信聊天数据库正在写入，请稍后重试' }, 'c1');
 assert.match(html, /暂不可用/);
 assert.match(html, /微信聊天数据库正在写入/);
 assert.doesNotMatch(html, /当前没有正在执行的自动回复/);
});
