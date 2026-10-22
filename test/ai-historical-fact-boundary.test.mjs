import test from 'node:test';
import assert from 'node:assert/strict';
import {unsupportedPersonalAnswer} from '../server/ai-personal-answer.mjs';

const now = Date.parse('2026-10-22T01:00:00Z');
const human = (text, extra = {}) => ({direction: 'self', authorship: 'human', text, timestamp: Math.floor(now / 1000) - 60, ...extra});
const other = (text, extra = {}) => ({direction: 'other', authorship: 'other', text, timestamp: Math.floor(now / 1000) - 30, ...extra});

test('unsupported historical first-person assumptions, mistakes and experiences are final-boundary violations', () => {
  for (const text of [
    '原来照片还压箱底呢😂 我差点真以为你今天出去玩了。',
    '你说得对，退款申请成功不等于钱已经到账，是我之前没区分清楚，抱歉。',
    '明白，是我认错了。不会再把另一个人的安排套到你这里。',
    '刚才理解错了，原来是你哥哥搬家。',
    '我以前也遇到过这种事。',
    '我之前说过已经处理好了。',
    '我刚刚把两个人记混了。',
  ]) assert.equal(unsupportedPersonalAnswer([text], {now}), 'personal-fact', text);
});

test('a counterpart correction or unrelated and generated self histories cannot establish a historical self claim', () => {
  const candidate = '是我之前没区分清楚。';
  for (const messages of [
    [other('你刚才没区分清楚。')],
    [human('我之前没区分清楚。', {aiGenerated: true})],
    [human('我之前没区分清楚。', {authorship: 'unknown'})],
    [human('我之前没区分清楚。', {timestamp: Math.floor(now / 1000) + 60})],
    [human('我今天喝了茶。')],
    [human('他说“我之前没区分清楚”。')],
    [human('如果我之前没区分清楚，请你纠正我。')],
  ]) assert.equal(unsupportedPersonalAnswer([candidate], {now, messages}), 'personal-fact', JSON.stringify(messages));
  assert.equal(unsupportedPersonalAnswer(['我还以为你去了北京。'], {now, messages: [human('我以为你去了上海。')]}), 'personal-fact');
});

test('direct human self sources support the same historical claim without approving unrelated claims', () => {
  assert.equal(unsupportedPersonalAnswer(['是我之前没区分清楚。'], {now, messages: [human('我之前没区分清楚。')]}), '');
  assert.equal(unsupportedPersonalAnswer(['我还以为你今天出去玩了。'], {now, messages: [human('我以为你今天出去玩了。')]}), '');
  assert.equal(unsupportedPersonalAnswer(['我以前也遇到过这种事。'], {now, messages: [human('我以前也遇到过这种事。', {timestamp: Math.floor(now / 1000) - 864000})]}), '');
  assert.equal(unsupportedPersonalAnswer(['我刚才说钱已经到账了。'], {now, messages: [human('钱已经到账了。')]}), '');
  assert.equal(unsupportedPersonalAnswer(['我刚才说钱已经到账了。'], {now, messages: [other('钱已经到账了。')]}), 'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['我刚才理解错了。'], {now, messages: [human('我刚才理解错了。', {timestamp: Math.floor(now / 1000) - 864000})]}), 'personal-fact');
});

test('ordinary acknowledgement, third-person reports, quotations, conditions and denials remain intact', () => {
  for (const text of [
    '明白，抱歉。', '不好意思，知道了。', '我觉得这样挺好。',
    '他之前没区分清楚。', '你之前认错了。', '他说，刚才理解错了。', '小王说，我之前理解错了。',
    '他说“我之前没区分清楚”。', '“我以为你到了”是他的话。',
    '如果我之前理解错了，请你纠正我。', '假如我以为你到了，那也只是一个假设。',
    '不是说我刚才理解错了。', '我没有说我之前认错了。',
    '我之前认错了吗？', '你是说我之前记错了？',
  ]) assert.equal(unsupportedPersonalAnswer([text], {now}), '', text);
  assert.equal(unsupportedPersonalAnswer(['他说“没事”，我以前也搞混过。'], {now}), 'personal-fact');
});

test('a rejected appointment does not establish the recipient arrived or made a wasted trip', () => {
  const messages = [other('刚刚被放鸽子了，有点难受。')];
  for (const text of ['突然被放鸽子确实挺难受的，人到了却没等到，确实会很失落。', '你人都到现场了，确实挺难受。', '你白跑了一趟，难免失落。'])
    assert.equal(unsupportedPersonalAnswer([text], {now, messages}), 'recipient-fact', text);
  for (const text of ['突然被放鸽子确实挺难受的。', '如果你人都到了，那确实会失落。', '你到了就告诉我。', '他说“人到了却没等到”。', '他人都到现场了。', '你到现场了吗？'])
    assert.equal(unsupportedPersonalAnswer([text], {now, messages}), '', text);
});

test('recipient arrival sources require an actual matching actor and action rather than plans or generated messages', () => {
  const candidate = '你人都到现场了。';
  assert.equal(unsupportedPersonalAnswer([candidate], {now, messages: [other('我已经到现场了。')]}), '');
  assert.equal(unsupportedPersonalAnswer([candidate], {now, messages: [human('你已经到现场了。')]}), '');
  for (const text of ['我准备到现场了。', '我没有到现场。', '我哥哥已经到现场了。', '他说“我已经到现场了”。', '如果我到现场了会告诉你。'])
    assert.equal(unsupportedPersonalAnswer([candidate], {now, messages: [other(text)]}), 'recipient-fact', text);
  assert.equal(unsupportedPersonalAnswer([candidate], {now, messages: [other('我已经到现场了。', {aiGenerated: true})]}), 'recipient-fact');
  assert.equal(unsupportedPersonalAnswer([candidate], {now, pendingMessages: [other('我现在到了。', {speaker: {id: 'person-A'}})], messages: [other('我已经到现场了。', {speaker: {id: 'person-B'}})]}), 'recipient-fact');
});

test('segmented output cannot hide historical assertions or recipient actions', () => {
  assert.equal(unsupportedPersonalAnswer(['是我之前没区分', '清楚。'], {now}), 'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['人到', '了却没等到。'], {now}), 'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['他说“我之前没区分', '清楚”。'], {now}), '');
});

test('a later question or unrelated human recipient statement does not disable the fact boundary', () => {
  assert.equal(unsupportedPersonalAnswer(['是我之前认错了。你觉得呢？'], {now}), 'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['你人到了却没等到。现在还好吗？'], {now}), 'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['你人都到现场了。'], {now, messages: [human('你今天喝茶了吗？')]}), 'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['你白跑了一趟。'], {now, messages: [other('我已经到现场了。')]}), 'recipient-fact');
  assert.equal(unsupportedPersonalAnswer(['我以为“上海”是地点。'], {now, messages: [human('我以为“北京”是地点。')]}), 'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['你到了现场，人白跑了一趟。'], {now, messages: [other('我已经到现场了。')]}), 'recipient-fact');
  for (const text of ['是我之前认错了，你觉得呢？', '我之前没区分清楚，如果需要你再说。', '如果不方便就算了，但我之前认错了。'])
    assert.equal(unsupportedPersonalAnswer([text], {now}), 'personal-fact', text);
  assert.equal(unsupportedPersonalAnswer(['你人到了却没等到，后面要是换个地方再聊。'], {now}), 'recipient-fact');
});

test('colloquial past mistakes require the same actor-authoritative evidence', () => {
  for (const verb of ['记岔', '搞岔', '弄岔', '听岔', '说岔', '看岔', '理解岔']) {
    assert.equal(unsupportedPersonalAnswer([`对，是我${verb}了。`], {now}), 'personal-fact', verb);
    assert.equal(unsupportedPersonalAnswer([`我${verb}了。`], {now, messages: [human(`我${verb}了。`)]}), '', verb);
    for (const allowed of [`你${verb}了。`, `他说“我${verb}了”。`, `如果我${verb}了，你纠正我。`, `我${verb}了吗？`])
      assert.equal(unsupportedPersonalAnswer([allowed], {now}), '', allowed);
  }
  assert.equal(unsupportedPersonalAnswer(['对，你只说喜欢茶，是我记岔了。'], {now}), 'personal-fact');
  assert.equal(unsupportedPersonalAnswer(['行，是我记岔了，你喜欢茶。那回头选茶的时候叫上你。'], {now}), 'future-notice');
});
