import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messageSegments, generationProtocol, learningPrompt, batchLearningPrompt, learningWithMemoryPrompt, batchLearningWithMemoryPrompt } from '../server/ai-prompts.mjs';
import { memoryLearningPrompt, memoryPrompt } from '../server/ai-wiki.mjs';

// 真机实测（2026-09-22，MiniMax-M3）：自动回复里模型把不需要的字段也写进 JSON，
// 例如 {"action":"send","text":"…","segments":null}。旧逻辑按"字段是否出现"判断，
// 于是 text 与 segments 被当成同时返回，直接报「text 与 segments 必须且只能返回一种」。
// 未使用的字段被写成 null / 空数组 / 空字符串时，一律按没有返回处理。
test('未使用的字段被写成 null、空数组或空字符串时按未提供处理', () => {
  assert.deepEqual(messageSegments({ action: 'send', text: '你好', segments: null }, { multiTurn: false }), ['你好']);
  assert.deepEqual(messageSegments({ action: 'send', text: '你好', segments: [] }, { multiTurn: false }), ['你好']);
  assert.deepEqual(messageSegments({ action: 'send', text: '', segments: ['第一句', '第二句'] }, { multiTurn: true }), ['第一句', '第二句']);
  // 动作大小写与前后空格不影响解析，并回写规范化后的动作，避免上层判断不一致。
  const result = { action: ' Send ', text: '你好' };
  assert.deepEqual(messageSegments(result, { multiTurn: false }), ['你好']);
  assert.equal(result.action, 'send');
  // followUp 写成 null 不算格式错误。
  assert.deepEqual(messageSegments({ action: 'send', text: '你好', followUp: null }, { multiTurn: true }), ['你好']);
  // 非发送动作携带空正文仍然放行。
  assert.deepEqual(messageSegments({ action: 'skip', text: null, segments: [] }, {}), []);
});

// 真机实测（2026-09-22）：模型仍可能同时返回 text 与 segments，或把载体写错形状。
// 能挽救的不再整条作废：同时返回按发送方式取一种；text 写成字符串数组、segments
// 写成单个字符串或 {text} 对象数组时，先归一成协议形状再解析。
test('越界返回能挽救时不作废：双载体取一种、错形状先归一', () => {
  // 同时返回：多段取 segments，单条取 text。
  assert.deepEqual(messageSegments({ action: 'send', text: '你好', segments: ['也发'] }, { multiTurn: true }), ['也发']);
  assert.deepEqual(messageSegments({ action: 'send', text: '你好', segments: ['也发'] }, { multiTurn: false }), ['你好']);
  // text 写成字符串数组 → 当作 segments。
  assert.deepEqual(messageSegments({ action: 'send', text: ['第一句', '第二句'] }, { multiTurn: true }), ['第一句', '第二句']);
  // segments 写成单个字符串 → 包成数组。
  assert.deepEqual(messageSegments({ action: 'send', segments: '你好' }, { multiTurn: true }), ['你好']);
  // segments 写成 {text} 对象数组 → 取出 text。
  assert.deepEqual(messageSegments({ action: 'send', segments: [{ text: '第一句' }, { text: '第二句' }] }, { multiTurn: true }), ['第一句', '第二句']);
});

test('解析仍然严格：动作无效、正文缺失或分段数量越界一律报错', () => {
  assert.throws(() => messageSegments({ action: 'send' }, { multiTurn: false }), /模型未返回待发送正文/);
  assert.throws(() => messageSegments({ action: 'wait' }, { multiTurn: false }), /动作无效/);
  assert.throws(() => messageSegments({ action: 'send', segments: ['一', '二', '三', '四'] }, { multiTurn: true }), /1–3 段/);
  assert.throws(() => messageSegments({ action: 'send', segments: ['一'] }, { multiTurn: false }), /单条发送/);
  assert.throws(() => messageSegments({ action: 'skip', text: '还是发了' }, {}), /非发送动作不能携带/);
  assert.throws(() => messageSegments({ action: 'send', text: '你好', followUp: 'true' }, { multiTurn: true }), /续聊字段无效/);
  assert.throws(() => messageSegments({ action: 'skip' }, { allowSkip: false }), /必须发送消息/);
});

test('提示词对返回结构有明确约定，对正文写法不做格式化要求', () => {
  const protocol = generationProtocol({ multiTurn: true });
  assert.match(protocol, /只返回 JSON 本身/);
  assert.match(protocol, /不要写成 null、空字符串或空数组/);
  assert.match(protocol, /action 必须是小写英文单词/);
  // 内容与格式要求放宽：不再限定字数、行数、条目化模板。
  for (const prompt of [learningPrompt, batchLearningPrompt, memoryLearningPrompt]) {
    assert.doesNotMatch(prompt, /不超过 \d+ 字/);
    assert.doesNotMatch(prompt, /不要换行/);
    assert.match(prompt, /只返回 JSON/);
  }
  assert.match(batchLearningPrompt, /profiles 的长度必须与输入 conversations 的长度完全一致/);
});

test('记忆学习覆盖全部材料、筛掉寒暄占位并允许空 entries', () => {
  for (const prompt of [memoryLearningPrompt, memoryPrompt]) {
    assert.match(prompt, /全部聊天材料/);
    assert.match(prompt, /好友验证/);
    assert.match(prompt, /问候寒暄/);
    assert.match(prompt, /链接.*占位文本/);
    assert.match(prompt, /稳定偏好.*关系信息.*重要事件.*已确认约定/);
    assert.match(prompt, /多条互不重复的事实分别写成条目/);
    assert.match(prompt, /不凑数量.*不编造/);
    assert.match(prompt, /entries/);
  }
  assert.match(memoryLearningPrompt, /"entries":\[\]/);
  for (const prompt of [learningWithMemoryPrompt, batchLearningWithMemoryPrompt]) {
    assert.doesNotMatch(prompt, /memoryMaterial/);
    assert.match(prompt, /entries 可以为空/);
    assert.doesNotMatch(prompt, /不要写成 null、空字符串或空数组/);
  }
});
