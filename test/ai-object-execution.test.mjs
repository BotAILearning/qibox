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
 assert.match(objectExecutionStatus(state([{ id: 'p1', phase: 'requesting' }]), 'c1'), /AI 请求中/);
 assert.doesNotMatch(objectExecutionStatus(state([{ id: 'p1', phase: 'generating' }]), 'c1'), /data-ai-skip-reply-wait/);
 assert.doesNotMatch(objectExecutionStatus(state([{ id: 'p1', phase: 'waiting', reason: '追问等待' }]), 'c1'), /data-ai-skip-reply-wait/);
});
test('enabled reply explains data recovery without a generic unavailable state', () => {
 const html = objectExecutionStatus({ ...state([]), available: false, waiting: true, notice: '微信聊天数据库正在写入，请稍后重试' }, 'c1');
 assert.match(html, /正在恢复微信读取/);
 assert.match(html, /微信聊天数据库正在写入/);
 assert.doesNotMatch(html, /当前没有正在执行的自动回复/);
});

test('execution shows only the current phase and preserves a skip button after countdown', () => {
 const base = state([{ id: 'p1', phase: 'waiting', reason: '群聊合并等待', dueAt: Date.now() + 8000, canSkipWait: true }]);
 const waiting = objectExecutionStatus(base, 'c1');
 assert.match(waiting, /等待汇总/);
 assert.doesNotMatch(waiting, /汇总上下文|AI 请求中|发送中|已发送/);
 assert.match(waiting, /data-ai-countdown=/);
 assert.match(waiting, /跳过等待/);
 const completed = objectExecutionStatus({ ...base, live: [], profiles: [{ ...base.profiles[0], replyFlow: { phase: 'sent', steps: { waiting: 1, summarizing: 2, requesting: 3, sending: 4, sent: 5 } } }] }, 'c1');
 assert.match(completed, /当前没有正在执行/);
 assert.doesNotMatch(completed, /data-ai-skip-reply-wait/);
});

test('send failure remains visible and can retry directly', () => {
 const base = state([{ id: 'p1', phase: 'waiting', reason: '发送失败，等待重试', dueAt: Date.now() + 30000, canSkipWait: true, canRetry: true }]);
 base.profiles[0].replyFlow = { phase: 'failed', detail: '消息未发送，等待自动重试', steps: { waiting: 1, summarizing: 2, requesting: 3, sending: 4, failed: 5 } };
 const html = objectExecutionStatus(base, 'c1');
 assert.match(html, /发送失败，等待重试/);
 assert.match(html, /剩余 \d+ 秒/);
 assert.match(html, /data-ai-skip-reply-wait/); assert.match(html, /直接重试/);
});
