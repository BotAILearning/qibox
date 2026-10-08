import test from 'node:test';
import assert from 'node:assert/strict';
import { skipRecordsView } from '../web/ai-activity-view.mjs';

const state = record => ({ profiles: [{ id: 'group-p', kind: 'group', contact: 'group-c', label: '项目讨论群' }], contacts: [], skipRecords: [{ id: 'skip-1', target: 'group-p', at: 1790660000000, source: 'model-skip', reasonCode: 'model-no-reply', messageId: 'incoming-2', ...record }] });
test('unreplied review shows each actual sender and message independently from its group and reason', () => {
  const html = skipRecordsView(state({ incomingMessages: [
    { id: 'incoming-1', senderName: '成员甲', text: '第一条问题\n补充一行', timestamp: 1790659000 },
    { id: 'incoming-2', senderName: '成员乙', text: '<img src=x onerror=alert(1)>', type: 'image' },
  ] }));
  for (const text of ['项目讨论群', '成员甲', '成员乙', '第一条问题\n补充一行', '模型判断本轮无需回复', 'data-message-id="incoming-2"']) assert.ok(html.includes(text));
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(html, /<img src=x/);
  assert.equal((html.match(/class="ai-skip-sender"/g) || []).length, 2);
  assert.match(html, /<details class="ai-skip-message-disclosure" data-ai-skip-messages="skip-1"/);
  assert.match(html, /2 条消息/);
  assert.match(html, /成员乙：&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(skipRecordsView({ ...state({ incomingMessages: [{ id: 'm1', text: '一' }, { id: 'm2', text: '二' }] }), skipMessageExpanded: ['skip-1'] }), /data-ai-skip-messages="skip-1" open/);
  assert.match(skipRecordsView({ skipRecords: [{ target: 'group-p', at: 1, incomingMessages: [{ text: '一' }, { text: '二' }] }] }), /data-ai-skip-messages="group-p:1"/);
});
test('unknown group identities never use the group name as sender; unavailable and media states are explicit', () => {
  const html = skipRecordsView(state({ incomingMessages: [{ id: 'm', text: '', type: 'voice', senderId: '0123456789abcdef' }] }));
  assert.match(html, /群成员（01234567）/);
  assert.match(html, /\[语音\]/);
  assert.doesNotMatch(html, /ai-skip-message-disclosure/);
  assert.doesNotMatch(html, /ai-skip-sender">项目讨论群/);
  const missing = skipRecordsView(state({ contentUnavailable: true, contentUnavailableMessage: '原消息已不可读取 <重试>' }));
  assert.match(missing, /原消息已不可读取 &lt;重试&gt;/);
  assert.doesNotMatch(missing, />true</);
  assert.match(skipRecordsView({}), /暂无未回复记录/);
});


test('group skip review shows specific reasons and preserves honest wording for legacy records', () => {
  for (const [reasonCode, label, trigger] of [
    ['group-at-others', '消息仅 @ 其他成员，本轮不参与'],
    ['group-mentions-unverified', '无法确认消息的 @ 对象'],
    ['group-at-me-disabled', '该群未开启 @我时回复', 'atMe'],
    ['group-at-all-disabled', '该群未开启 @所有人时回复', 'atAll'],
    ['group-realtime-disabled', '该群未开启实时回复', 'realtime'],
    ['group-trigger-missing', '来信未满足已开启的群聊回复条件', 'realtime'],
  ]) {
    const html = skipRecordsView(state({ source: 'system-skip', reasonCode, trigger }));
    assert.ok(html.includes(label)); assert.doesNotMatch(html, /群聊未配置触发方式/);
    if (!trigger) assert.doesNotMatch(html, /系统拦截 · 群聊实时/);
  }
});
