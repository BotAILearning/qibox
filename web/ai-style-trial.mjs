const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function styleTrialMarkup(trial = {}) {
  const unavailable = trial.busy || trial.stale;
  const scenes = (trial.result?.trials || []).map(scene => {
    const feedback = trial.feedback?.[scene.id] || {};
    return `<details class="qi-disclosure" data-style-trial-scene="${esc(scene.id)}"><summary>${esc(scene.label)}</summary><div>${scene.messages.map(row => `<p><b>${row.direction === 'self' ? '本人前文' : '对方'}：</b>${esc(row.text)}</p>`).join('')}<p><b>试聊回复：</b>${esc(scene.reply)}</p><div class="ai-actions" aria-label="${esc(scene.label)}的评价">${[['like', '像我'], ['unlike', '不像我']].map(([key, label]) => `<button type="button" class="quiet" data-style-trial-feedback="${key}" data-style-trial-id="${esc(scene.id)}" aria-pressed="${feedback.verdict === key}" ${unavailable ? 'disabled' : ''}>${label}</button>`).join('')}</div>${feedback.verdict === 'unlike' ? `<label class="ai-field"><span>希望怎样调整表达</span><textarea class="qi-input" rows="2" maxlength="400" data-style-trial-note="${esc(scene.id)}" ${unavailable ? 'disabled' : ''} placeholder="例如：这类分享接一句就好，不要再给建议">${esc(feedback.note || '')}</textarea></label><button type="button" class="quiet" data-style-trial-apply="${esc(scene.id)}" ${unavailable ? 'disabled' : ''}>加入新风格草稿</button>` : ''}</div></details>`;
  }).join('');
  return `<section class="ai-style-trial" data-style-trial-region aria-label="风格试聊"><div class="ai-actions"><button type="button" class="secondary" data-style-trial-generate ${trial.busy ? 'disabled' : ''} aria-describedby="ai-style-trial-cost">生成试聊</button>${trial.busy ? '<button type="button" class="quiet" data-style-trial-stop>停止试聊</button>' : ''}${trial.canUndo ? '<button type="button" class="quiet" data-style-trial-undo>撤销本次草稿修改</button>' : ''}</div><p class="ai-help" id="ai-style-trial-cost">使用当前风格草稿和聊天模型，一次请求生成五个合成场景，按上游服务计费。不会发微信、保存设置或加入学习；失败不自动重试。</p><p role="status" aria-live="polite" ${trial.busy || trial.notice ? '' : 'hidden'}>${esc(trial.busy ? '正在生成试聊…' : trial.notice)}</p>${trial.error ? `<p class="ai-style-trial-error" role="alert">${esc(trial.error)}</p>` : ''}${trial.result ? `<div class="ai-style-trial-results"><p class="ai-help">${trial.stale ? '以下是修改前的试聊，重新生成后查看当前草稿效果。' : '合成场景 · 仅供查看风格，不代表真实聊天已通过验收。'}评价不会调用模型；补充只写表达习惯，加入草稿后仍须保存设置。原风格保留，可从风格来源重新选择。</p>${scenes}</div>` : ''}</section>`;
}

export function updateStyleTrialRegion(region, trial) {
  if (!region) return;
  const doc = region.ownerDocument;
  const opened = new Set([...region.querySelectorAll('[data-style-trial-scene][open]')].map(row => row.dataset.styleTrialScene));
  const focus = doc.activeElement?.hasAttribute?.('data-style-trial-stop') || doc.activeElement?.hasAttribute?.('data-style-trial-generate');
  const active = doc.activeElement;
  const feedbackFocus = active?.dataset?.styleTrialFeedback;
  const feedbackId = active?.dataset?.styleTrialId;
  region.outerHTML = styleTrialMarkup(trial);
  const next = doc.querySelector('[data-style-trial-region]');
  for (const row of next.querySelectorAll('[data-style-trial-scene]')) row.open = opened.has(row.dataset.styleTrialScene);
  if (focus) next.querySelector(trial.busy ? '[data-style-trial-stop]' : '[data-style-trial-generate]')?.focus({ preventScroll: true });
  else if (feedbackFocus && /^[a-z-]+$/.test(feedbackId || '')) next.querySelector(`[data-style-trial-feedback="${feedbackFocus}"][data-style-trial-id="${feedbackId}"]`)?.focus({ preventScroll: true });
}

// The controller owns only this optional preview. It cannot cancel replies,
// persist settings, learn from feedback, or send WeChat messages.
export function createStyleTrialUI({ api, scope, draft, changed, applyCorrection }) {
  let state = {}, active = null, completed = null, undo = null, undoScope = null;
  const emit = () => changed(state);
  function cancel({ clear = false, stale = false } = {}) {
    const op = active; active = null;
    if (!op && !state.result && !state.busy && !state.error && !state.notice) return;
    if (op) {
      op.controller.abort();
      api(`/instances/${op.instance}/ai`, { action: 'style-trial-cancel', value: { operationId: op.operationId, account: op.account } }, 15000).catch(() => {});
    }
    if (clear) { completed = null; undo = null; undoScope = null; }
    state = clear ? {} : { ...state, busy: false, stale: stale || state.stale, error: '', notice: op ? '已停止试聊；已发出的上游请求仍可能计费。' : state.notice };
    emit();
  }
  function current(op) {
    const now = scope();
    try { return active === op && now.verified && now.instance === op.instance && now.account === op.account && now.contact === op.contact && now.revision === op.revision && JSON.stringify(draft()) === op.draftKey; }
    catch { return false; }
  }
  function resultCurrent() {
    if (!completed || !state.result || state.busy || state.stale) return false;
    const now = scope();
    try { return now.verified && ['instance','account','contact','revision'].every(key => now[key] === completed[key]) && JSON.stringify(draft()) === completed.draftKey; }
    catch { return false; }
  }
  function feedback(id, verdict) {
    if (!resultCurrent() || !state.result.trials.some(row => row.id === id) || !['like','unlike'].includes(verdict)) return;
    state = { ...state, feedback: { ...state.feedback, [id]: { ...state.feedback?.[id], verdict } }, error: '' }; emit();
  }
  function note(id, text) {
    if (!resultCurrent() || state.feedback?.[id]?.verdict !== 'unlike' || typeof text !== 'string' || text.length > 400) return;
    state.feedback[id] = { ...state.feedback[id], note: text };
    // The existing textarea owns focus/caret; do not replace it per keystroke.
  }
  function apply(id) {
    if (!resultCurrent() || state.feedback?.[id]?.verdict !== 'unlike' || !applyCorrection) return;
    const text = state.feedback[id].note?.trim();
    if (!text) { state = { ...state, error: '请先说明希望怎样调整表达；不会根据“不像我”自动猜测。' }; emit(); return; }
    try {
      const result = applyCorrection({ note: text, draft: draft() });
      undo = result?.undo || null;
      undoScope = { ...scope() };
      state = { ...state, stale: true, canUndo: !!undo, notice: '已加入新的风格草稿，保存设置后生效；原风格未修改。需要看新效果时再点击生成试聊。', error: '' };
    } catch (error) { state = { ...state, error: error.message }; }
    emit();
  }
  function undoCorrection() {
    if (!undo) return;
    try {
      const now = scope();
      if (!now.verified || !['instance','account','contact','revision'].every(key => now[key] === undoScope?.[key])) throw new Error('当前对象或设置已变化，未覆盖草稿；可从风格来源重新选择原风格。');
      if (!undo()) throw new Error('草稿或当前对象已变化，未覆盖你的修改；可从风格来源重新选择原风格。');
      undo = null; undoScope = null; state = { ...state, stale: false, canUndo: false, notice: '已恢复修改前的草稿；未保存设置，也未调用模型。', error: '' };
    } catch (error) { state = { ...state, error: error.message }; }
    emit();
  }
  function saved() {
    const corrected = !!undo; undo = null; undoScope = null;
    state = { ...state, canUndo: false, stale: !!state.result, ...(corrected ? { notice: '新风格已保存；原风格保留，可从风格来源重新选择。' } : {}) }; emit();
  }
  async function generate() {
    if (active) return;
    const target = scope();
    if (!target.verified || !target.instance || !target.account || !target.contact) return;
    let value;
    try { value = draft(); } catch (error) { state = { ...state, error: error.message }; emit(); return; }
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    const op = { ...target, operationId: [...bytes].map(x => x.toString(16).padStart(2, '0')).join(''), controller: new AbortController(), draftKey: JSON.stringify(value) };
    active = op; state = { ...state, busy: true, notice: '', error: '' }; emit();
    try {
      const result = await api(`/instances/${op.instance}/ai`, { action: 'style-trial', value: { ...value, account: op.account, contact: op.contact, operationId: op.operationId } }, 180000, { signal: op.controller.signal });
      if (!current(op) || result.operationId !== op.operationId || result.account !== op.account || result.contact !== op.contact) return;
      completed = op;
      state = { busy: false, result, stale: false, notice: '', error: '', canUndo: !!undo };
    } catch (error) {
      if (current(op)) state = { ...state, busy: false, error: `${error.message}。风格草稿和上次结果已保留，本次不会自动重试。` };
    } finally { if (active === op) { active = null; state.busy = false; emit(); } }
  }
  return { generate, cancel, feedback, note, apply, undoCorrection, saved, value: () => {
    if (undo) {
      const now = scope();
      if (!now.verified || !['instance','account','contact','revision'].every(key => now[key] === undoScope?.[key])) { undo = null; undoScope = null; state = { ...state, canUndo: false }; }
    }
    if (state.result && !active && !state.stale && !resultCurrent()) state = { ...state, stale: true };
    return state;
  } };
}
