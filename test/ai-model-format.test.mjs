import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelResult } from '../server/ai-provider.mjs';

// 真机实测（2026-09-22，MiniMax-M3 / anthropic 协议）：学习风格时模型把提示词模板里的层名
// 当成值又写了一遍，输出 "language":"语言层":"样本不足" —— 不是合法 JSON，此前直接报
// 「模型返回的内容格式无效」。解析失败时应先做一次保守修复再判定失败。
test('学习结果中重复取值片段与多余逗号可被修复', () => {
  const text = '{"style":{"language":"语言层":"样本不足","rhythm":"节奏层":"回复偏快","interaction":"互动层":"少提问","emotion":"样本不足","role":"角色层":"跟随者"}}';
  const result = modelResult(text);
  assert.equal(result.style.language, '样本不足');
  assert.equal(result.style.rhythm, '回复偏快');
  assert.equal(result.style.role, '跟随者');
  const comma = modelResult('{"action":"send","text":"你好",}');
  assert.deepEqual(comma, { action: 'send', text: '你好' });
});

// 真机实测形态（2026-09-22，MiniMax-M3 / anthropic 协议）：分段发送时模型把每条消息
// 各写成一个对象且都不闭合，整段不是合法 JSON。此时应取回第一个带业务字段的对象，
// 而不是整个请求失败。
test('多个未闭合的对象可以取回第一个可用结果', () => {
  const text = '{"action":"send","segments":["嗯 真的"],{"action":"send","segments":["晚上见个面不 把东西给你看"],{"action":"send","segments":["正好当面聊聊校友会的事"]}';
  assert.deepEqual(modelResult(text), { action: 'send', segments: ['嗯 真的'] });
  const report = '{"report":"第一段：双方确认了周末见面的时间。"},{"report":"第二段：对方提起加班。"}';
  assert.throws(() => modelResult(report, 'report'), /多个报告对象/);
});

// 真机实测形态（2026-09-22，MiniMax-M3 / anthropic 协议）：模型在字符串值内部写了
// 未转义的引号，"偶尔用"嗯呢""好哦"这类词" 不是合法 JSON。只有紧跟结构字符的引号
// 才是字符串结束，其余按内容转义回来。
test('字符串值内部未转义的引号可被还原', () => {
  const text = '{"style":{"language":"偶尔用"嗯呢""好哦"这类词，标点基本不用","rhythm":"回复慢，一次只发一条"}}';
  const result = modelResult(text);
  assert.equal(result.style.language, '偶尔用"嗯呢""好哦"这类词，标点基本不用');
  assert.equal(result.style.rhythm, '回复慢，一次只发一条');
});

test('分析报告 JSON 字符串中的原始换行和制表符可被还原', () => {
  const raw = '{"report":"数据开场\n\n双方最近聊了两件事。\t其中一项已有明确结论。","excerptIds":["m1"]}';
  const result = modelResult(raw, 'report');
  assert.equal(result.report, '数据开场\n\n双方最近聊了两件事。\t其中一项已有明确结论。');
  assert.deepEqual(result, { report: '数据开场\n\n双方最近聊了两件事。\t其中一项已有明确结论。' });
});

test('结构仍然严格要求：散文、数组、截断与多个对象一律判为格式无效', () => {
  for (const text of ['send hello', '[{"action":"send"}]', '{"report":', '<think>incomplete', '{} {}', '{"foo":"bar"},{"foo":"baz"}']) assert.throws(() => modelResult(text));
  assert.throws(() => modelResult('{"report":', 'report'));
  assert.deepEqual(modelResult('这是正文', 'report'), { report: '这是正文' });
});
