const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
  return `<div class="ai-pending-memory"><h5>${merged ? '合并后的记忆（待确认）' : '本次学习到的记忆（待确认）'}</h5>${profile.pendingMemoryCoverage ? `<p class="ai-help">${esc(coverageText(profile.pendingMemoryCoverage))}</p>` : ''}<p class="ai-pending-memory-text">${esc(pending.summary || '本次没有提取到明确记忆。')}</p>${running ? '<p class="ai-help">正在与原有记忆合并，请稍候…</p>' : ''}${failed ? `<p class="ai-help">合并失败：${esc(merge.reason || '请重试')}</p>` : ''}<div class="ai-actions"><button type="button" class="primary" data-ai-memory-apply="${esc(profile.id)}"${running ? ' disabled' : ''}>替换</button><button type="button" class="secondary" data-ai-memory-merge="${esc(profile.id)}"${running ? ' disabled' : ''}>与原有记忆合并</button><button type="button" class="quiet" data-ai-memory-discard="${esc(profile.id)}"${running ? ' disabled' : ''}>取消</button></div><p class="ai-help">替换：用这份直接覆盖当前记忆，旧记忆仍可从修改历史恢复。合并：把这份与当前记忆交给模型整理成一份，整理完成后还要再确认一次。</p></div>`;
}
export function memoryFields(profile, draft) {
  return `<h4>聊天记忆</h4>${pendingMemoryFields(profile)}${profile?.memoryCoverage ? `<p class="ai-help">${esc(coverageText(profile.memoryCoverage))}</p>` : ''}<label class="ai-field"><span>可修改的记忆</span><textarea name="memorySummary" rows="3" maxlength="12000" placeholder="学习后会在这里整理双方已明确的信息，也可以手动补充。">${esc(draft ?? profile?.memory?.summary ?? '')}</textarea></label><p class="ai-help">学习与聊天均可增量更新；手动维护内容受保护。</p>${profile?.memoryHistory?.length ? `<details class="ai-memory-history"><summary>修改历史</summary>${profile.memoryHistory.map(h => `<button type="button" class="quiet" data-ai-memory-restore="${h.id}" data-profile="${profile.id}">恢复到 ${esc(new Date(h.at).toLocaleString('zh-CN'))} 前</button>`).join('')}</details>` : ''}${profile?.memory?.unavailable ? '<p class="ai-help">当前记忆暂时无法读取，请稍后重试。</p>' : ''}${profile?.memoryNotice ? `<p class="ai-help">${esc(profile.memoryNotice)}</p>` : ''}${profile?.memorySuggestion ? `<details class="ai-memory-suggestion"><summary>查看本次学习的记忆</summary><p>${esc(profile.memorySuggestion.summary || '本次没有提取到明确记忆。')}</p><button type="button" class="secondary" data-ai-adopt-memory="${profile.id}">将本次学习结果填入编辑框</button></details>` : ''}`;
}
