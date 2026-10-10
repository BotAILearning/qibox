import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisHistoryWindow, historyList, analysisHistorySelectionLabel } from '../web/ai-analysis-view.mjs';
import { historySummary } from '../server/ai-report-history.mjs';

const reports = Array.from({length:31}, (_,i) => ({id:String(i),label:i % 2 ? 'Bot报告' : '咖啡',createdAt:1791590400000,title:i === 20 ? 'ＡＢＣ 长标题' : '日常记录',actualRange:{from:'2026-10-01',to:'2026-10-10'}}));
test('history pages preserve every report once and clamp after deletion or an invalid requested page',()=>{
 const pages=Array.from({length:4},(_,i)=>analysisHistoryWindow(reports,'',i).items.map(r=>r.id));
 assert.deepEqual(pages.map(x=>x.length),[10,10,10,1]);assert.equal(new Set(pages.flat()).size,31);
 assert.equal(analysisHistoryWindow(reports.slice(0,20),'',3).page,1);
 assert.equal(analysisHistoryWindow(reports,'',NaN).page,0);assert.equal(analysisHistoryWindow(reports,'',-10).page,0);
 assert.equal(analysisHistoryWindow(reports,'no such title',3).page,0);
});
test('title, object, nickname, request and date searches combine terms and normalize case/fullwidth',()=>{
 assert.deepEqual(analysisHistoryWindow(reports,'abc 2026-10-01').items.map(r=>r.id),['20']);
 assert.equal(analysisHistoryWindow(reports,'bot').matched.length,15);
 const summary=historySummary({id:'long',label:'小森',nickname:'备注💊',request:'周末安排',createdAt:1791590400000,report:'# '+ '长'.repeat(180)+'尾部标题\n正文'});
 assert.equal(analysisHistoryWindow([summary],'尾部标题 备注💊').matched.length,1);
 assert.equal(analysisHistoryWindow([summary],'周末安排').matched.length,1);
});
test('a filtered empty result keeps its search controls and scopes selection to actual matching reports',()=>{
 const state={analysis:{history:reports}},query='<script>" & 不存在';
 const html=historyList(state,{historyQuery:query,selecting:true,selected:new Set()});
 assert.match(html,/找到 0 份，共 31 份/);assert.match(html,/没有匹配的报告/);assert.match(html,/&lt;script&gt;&quot; &amp;/);
 assert.doesNotMatch(html,/<script>/);assert.match(html,/data-ai-history-export-next disabled/);
 const matched=analysisHistoryWindow(reports,'Bot').matched;
 assert.match(analysisHistorySelectionLabel(new Set(),matched),/15/);
 assert.equal(analysisHistorySelectionLabel(new Set(matched.map(r=>r.id)),matched),'取消全选');
 assert.match(historyList({analysis:{history:[]}},{selecting:true}),/还没有保存的分析报告/);
});
