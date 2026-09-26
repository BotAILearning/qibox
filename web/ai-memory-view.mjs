const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const wikiOptions = [['name','姓名'],['phone','手机号码'],['birthday','生日'],['date','其他日期'],['school','学校/学历'],['household','户籍地'],['residence','居住地址'],['workplace','工作地点'],['employer','工作单位'],['shipping','收货地址'],['other','其他']];
export function wikiEntryMarkup(e, canSetWechatRemark = false) {
  const recorded = Number.isSafeInteger(e.recordedAt) && Math.abs(e.recordedAt) <= 8640000000000000 ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', dateStyle: 'medium', timeStyle: 'short' }).format(e.recordedAt) : '未知';
  const valueControl = e.field === 'other'
    ? `<textarea aria-label="信息内容" maxlength="2000" rows="1" placeholder="兴趣爱好、偏好或其他记忆">${esc(e.text)}</textarea>`
    : `<input aria-label="信息内容" maxlength="2000" value="${esc(e.text)}" placeholder="${e.field==='school'?'具体学校':'填写已确认的信息'}">`;
  return `<div class="ai-wiki-bubble"><input type="hidden" data-ai-wiki-id value="${esc(e.id||'')}"><input type="hidden" data-ai-wiki-recorded value="${esc(e.recordedAt ?? '')}"><select aria-label="信息类型">${wikiOptions.map(([v,l])=>`<option value="${v}" ${e.field===v?'selected':''}>${l}</option>`).join('')}</select>${e.field==='school'?`<small class="ai-wiki-school-name">${esc(e.degree||'学历未注明')}：${esc(e.text||'具体学校')}</small>`:''}${valueControl}<input class="ai-wiki-degree" aria-label="学历" maxlength="120" value="${esc(e.degree||'')}" placeholder="学历（如本科）" ${e.field==='school'?'':'hidden'}><label class="ai-wiki-date-type" ${['birthday','date'].includes(e.field)?'':'hidden'}>历法<select aria-label="生日历法"><option value="" ${e.calendar==='solar'||e.calendar==='lunar'?'':'selected'}>未确定</option><option value="solar" ${e.calendar==='solar'?'selected':''}>公历</option><option value="lunar" ${e.calendar==='lunar'?'selected':''}>农历</option></select></label><small class="ai-wiki-recorded" ${['residence','workplace','employer','shipping'].includes(e.field)?'':'hidden'}>时间：${recorded}</small>${canSetWechatRemark?`<button type="button" class="quiet" data-ai-wiki-remark ${e.field==='name'?'':'hidden'}>添加为微信备注</button>`:''}<button type="button" class="ai-wiki-remove" aria-label="删除信息" title="删除" data-ai-wiki-remove>×</button></div>`;
}
export function sameWikiEntries(a = [], b = []) {
  const normalize = entries => entries.map(entry => ({ id: entry.id || '', field: entry.field || 'other', text: String(entry.text || '').trim(), degree: entry.degree || '', calendar: entry.calendar || '', from: entry.from ?? null, to: entry.to ?? null, recordedAt: entry.recordedAt ?? null }));
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
function coverageText(value) {
  if (!value || typeof value !== 'object') return '';
  const date = stamp => Number.isSafeInteger(stamp) ? new Date(stamp * 1000).toLocaleDateString('zh-CN') : '';
  const range = value.from || value.to ? `，记录时间 ${date(value.from) || '未知'} 至 ${date(value.to) || '未知'}` : '';
  const cut = value.truncated || value.sourceTruncated ? '（范围已截断，只分析实际提供内容）' : '（所选范围完整）';
  return `实际覆盖 ${value.includedMessages ?? 0} 条、${value.includedChars ?? 0} 个 Unicode 字符${range}${cut}`;
}
// A memory run parks its result here instead of writing over what the user has.
// Replacing and merging are both explicit, and a merge result still has to be
// confirmed before it touches the stored memory.
export function pendingMemoryFields(profile) {
  const pending = profile?.pendingMemory;
  if (!pending) return '';
  const merge = profile.memoryMerge, running = merge?.status === 'running', failed = merge?.status === 'failed';
  const merged = profile.pendingMemorySource === 'merge';
  const empty = !pending.entries?.length;
  return `<div class="ai-pending-memory"><h5>${empty ? '本次学习未提取到记忆' : merged ? '合并后的记忆（待确认）' : '本次学习到的记忆（待确认）'}</h5>${profile.pendingMemoryCoverage ? `<p class="ai-help">${esc(coverageText(profile.pendingMemoryCoverage))}</p>` : ''}<p class="ai-pending-memory-text">${esc(pending.summary || '本次没有提取到明确记忆。')}</p>${empty ? '<p class="ai-help">已有记忆未改变。可以保留现有内容，或调整学习范围后重试。</p>' : ''}${running ? '<p class="ai-help">正在与原有记忆合并，请稍候…</p>' : ''}${failed ? `<p class="ai-help">合并失败：${esc(merge.reason || '请重试')}</p>` : ''}<div class="ai-actions">${empty ? '' : `<button type="button" class="primary" data-ai-memory-apply="${esc(profile.id)}"${running ? ' disabled' : ''}>替换</button><button type="button" class="secondary" data-ai-memory-merge="${esc(profile.id)}"${running ? ' disabled' : ''}>与原有记忆合并</button>`}<button type="button" class="quiet" data-ai-memory-discard="${esc(profile.id)}"${running ? ' disabled' : ''}>取消</button></div>${empty ? '' : '<p class="ai-help">替换：用这份直接覆盖当前记忆，旧记忆仍可从修改历史恢复。合并：把这份与当前记忆交给模型整理成一份，整理完成后还要再确认一次。</p>'}</div>`;
}
export function memoryHistoryMarkup(profile) {
  const entries = profile?.memoryHistory || [];
  if (!entries.length) return '';
  return `<details class="ai-memory-history"><summary>修改历史</summary>${entries.map(h => `<button type="button" class="quiet" data-ai-memory-restore="${esc(h.id)}" data-profile="${esc(profile.id)}">恢复到 ${esc(new Date(h.at).toLocaleString('zh-CN'))} 前</button>`).join('')}</details>`;
}
export function memoryFields(profile, draft, { heading = true, history = true } = {}) {
  const memories = profile?.memory?.entries || [];
  const options = wikiOptions;
  let draftEntries = null;
  if (typeof draft === 'string') { try { const parsed = JSON.parse(draft); if (Array.isArray(parsed)) draftEntries = parsed; } catch {} }
  const rows = draftEntries || (memories.length ? memories : (profile?.memory?.summary || draft ? [{ field: 'other', text: draft ?? profile.memory.summary }] : []));
  const canSetWechatRemark = profile?.capabilities?.writeContactRemark === true;
  const allFields = [
    ['name','姓名'], ['phone','手机号码'], ['birthday','生日'], ['date','其他日期'],
    ['school','学校'], ['household','户籍地'], ['residence','居住地址'],
    ['work','工作信息'], ['shipping','收货地址'], ['other','其他记忆']
  ];
  const sections = allFields.map(([field,label]) => {
    const entries = rows.filter(entry => field === 'work' ? ['workplace','employer'].includes(entry.field) : (entry.field || 'other') === field);
    const buttons = field === 'work' ? '<div class="ai-actions"><button type="button" class="quiet ai-wiki-add-field" data-ai-wiki-add data-ai-wiki-add-field="workplace">添加工作地点</button><button type="button" class="quiet ai-wiki-add-field" data-ai-wiki-add data-ai-wiki-add-field="employer">添加工作单位</button></div>' : `<button type="button" class="quiet ai-wiki-add-field" data-ai-wiki-add data-ai-wiki-add-field="${field}">添加${label}</button>`;
    const help = field === 'other' ? '<p class="ai-help">记录兴趣爱好、稳定偏好，以及双方其他聊天中值得保留的内容。旧版自由文本也会放在这里。</p>' : field === 'date' ? '<p class="ai-help">记录两个人之间的重要纪念日，如相识、确定关系或结婚纪念日。</p>' : '';
    return `<section class="ai-wiki-field" data-ai-wiki-field="${field}"><h5>${label}</h5><div class="ai-wiki-field-values">${entries.map(entry=>wikiEntryMarkup({...entry,field:entry.field || 'other'},canSetWechatRemark)).join('')}</div>${buttons}${help}</section>`;
  }).join('');
  return `${heading ? '<h4>聊天记忆</h4>' : ''}${pendingMemoryFields(profile)}${profile?.memoryCoverage ? `<p class="ai-help">${esc(coverageText(profile.memoryCoverage))}</p>` : ''}<div class="ai-wiki-entities" data-ai-wiki-entities>${sections}</div><button type="button" class="secondary" data-ai-wiki-add data-ai-wiki-add-field="other">添加信息</button><input type="hidden" name="memorySummary" value="">${history ? memoryHistoryMarkup(profile) : ''}${profile?.memory?.unavailable ? '<p class="ai-help">当前记忆暂时无法读取，请稍后重试。</p>' : ''}${profile?.memoryNotice ? `<p class="ai-help">${esc(profile.memoryNotice)}</p>` : ''}${profile?.memorySuggestion ? `<details class="ai-memory-suggestion"><summary>查看本次学习的记忆</summary><p>${esc(profile.memorySuggestion.summary || '本次没有提取到明确记忆。')}</p><button type="button" class="secondary" data-ai-adopt-memory="${profile.id}">将本次学习结果填入编辑框</button></details>` : ''}`;
}
