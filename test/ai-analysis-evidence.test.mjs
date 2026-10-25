import test from 'node:test';
import assert from 'node:assert/strict';
import {analysisEvidenceViolation, analysisOrderMode} from '../server/ai-analysis-evidence.mjs';
test('ordinary compound order requests retain chronological intent while quoted or negated requests do not', () => {
 for (const request of ['按原始时间顺序概括', '按照原文的时间顺序', '按照消息发送顺序整理', '按时间先后顺序', '依照发送时间顺序', '保持原始时间顺序', '以原始时间线整理', '按顺序保留关键更正']) assert.equal(analysisOrderMode(request), 'chronological', request);
 for (const request of ['不要按原始时间顺序', '这次不用按消息发送顺序', '报告不要按时间先后顺序', '他说“按原始时间顺序”，这里只回顾话题', '不要求保持原始时间顺序']) assert.equal(analysisOrderMode(request), '', request);
 assert.equal(analysisOrderMode('不要按原始时间顺序，按主题分类'), 'thematic');
 assert.equal(analysisOrderMode('按时间倒序整理'), 'reverse');
});
const messages=[
 {sequence:1,speaker:'对方',beijingTime:'2026-10-20 08:42:45',text:'QIBOX-STABLE-01 请回复收到'},
 {sequence:2,speaker:'本人',beijingTime:'2026-10-20 08:43:36',text:'收到🙂'},
 {sequence:3,speaker:'本人',beijingTime:'2026-10-20 09:04:50',text:'QIBOX-STABLE-PROACTIVE 问候'},
];
test('explicit report sequence claims retain original speaker and Beijing time',()=>{
 assert.equal(analysisEvidenceViolation('- sequence 1，对方，2026-10-20 08:42:45，原文：QIBOX-STABLE-01',messages),'');
 for(const line of ['sequence 1，本人，2026-10-20 08:42:45','sequence 1，对方，2026-10-20 20:42:45','sequence 4，本人，2026-10-20 08:42:45'])assert.equal(analysisEvidenceViolation(line,messages),'sequence');
});
test('marker ownership and whole-range coverage cannot contradict the cited source',()=>{
 assert.equal(analysisEvidenceViolation('两条 QIBOX-STABLE 标识均落在本人发言侧',messages),'marker-owner');
 assert.equal(analysisEvidenceViolation('本次共 3 条可读消息，对方 1 条、本人 2 条，均带 QIBOX-STABLE 标识',messages),'marker-coverage');
 assert.equal(analysisEvidenceViolation('QIBOX-STABLE-PROACTIVE 标识来自本人',messages),'');
 for(const text of ['两条标识分属本人和对方','他说“QIBOX-STABLE 标识均来自本人”','如果 QIBOX-STABLE 标识均来自本人'])assert.equal(analysisEvidenceViolation(text,messages),'');
});
