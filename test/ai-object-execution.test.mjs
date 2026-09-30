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
test('enabled reply reports a temporary data outage instead of idle', () => {
 const html = objectExecutionStatus({ ...state([]), available: false, waiting: true, notice: '微信聊天数据库正在写入，请稍后重试' }, 'c1');
 assert.match(html, /暂不可用/);
 assert.match(html, /微信聊天数据库正在写入/);
 assert.doesNotMatch(html, /当前没有正在执行的自动回复/);
});

test('execution shows every stage, a live countdown, and a confirmed result', () => {
 const base = state([{ id: 'p1', phase: 'waiting', reason: '群聊合并等待', dueAt: Date.now() + 8000 }]);
 const waiting = objectExecutionStatus(base, 'c1');
 for (const label of ['等待汇总', '汇总上下文', 'AI 请求中', '发送中', '已发送']) assert.match(waiting, new RegExp(label));
 assert.match(waiting, /data-ai-countdown=/);
 assert.match(waiting, /跳过倒计时/);
 const completed = objectExecutionStatus({ ...base, live: [], profiles: [{ ...base.profiles[0], replyFlow: { phase: 'sent', steps: { waiting: 1, summarizing: 2, requesting: 3, sending: 4, sent: 5 } } }] }, 'c1');
 assert.match(completed, /微信已确认发送/);
 assert.doesNotMatch(completed, /data-ai-skip-reply-wait/);
});

test('send failure remains visible with retry countdown and no skip button', () => {
 const base = state([{ id: 'p1', phase: 'waiting', reason: '发送失败，等待重试', dueAt: Date.now() + 30000 }]);
 base.profiles[0].replyFlow = { phase: 'failed', detail: '消息未发送，等待自动重试', steps: { waiting: 1, summarizing: 2, requesting: 3, sending: 4, failed: 5 } };
 const html = objectExecutionStatus(base, 'c1');
 assert.match(html, /本轮未发送/);
 assert.match(html, /剩余 \d+ 秒/);
 assert.doesNotMatch(html, /data-ai-skip-reply-wait/);
});
