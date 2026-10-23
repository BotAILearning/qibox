const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function styleTrialMarkup(trial = {}) {
  return `<section class="ai-style-trial" data-style-trial-region aria-label="风格试聊"><div class="ai-actions"><button type="button" class="secondary" data-style-trial-generate ${trial.busy ? 'disabled' : ''} aria-describedby="ai-style-trial-cost">生成试聊</button>${trial.busy ? '<button type="button" class="quiet" data-style-trial-stop>停止试聊</button>' : ''}</div><p class="ai-help" id="ai-style-trial-cost">使用当前风格草稿和聊天模型，一次请求生成五个合成场景，按上游服务计费。不会发微信、保存设置或加入学习；失败不自动重试。</p><p role="status" aria-live="polite" ${trial.busy || trial.notice ? '' : 'hidden'}>${esc(trial.busy ? '正在生成试聊…' : trial.notice)}</p>${trial.error ? `<p class="ai-style-trial-error" role="alert">${esc(trial.error)}</p>` : ''}${trial.result ? `<div class="ai-style-trial-results"><p class="ai-help">${trial.stale ? '以下是修改前的试聊，重新生成后查看当前草稿效果。' : '合成场景 · 仅供查看风格，不代表真实聊天已通过验收。'}</p>${trial.result.trials.map(scene => `<details class="qi-disclosure" data-style-trial-scene="${esc(scene.id)}"><summary>${esc(scene.label)}</summary><div>${scene.messages.map(row => `<p><b>${row.direction === 'self' ? '本人前文' : '对方'}：</b>${esc(row.text)}</p>`).join('')}<p><b>试聊回复：</b>${esc(scene.reply)}</p></div></details>`).join('')}</div>` : ''}</section>`;
}

export function updateStyleTrialRegion(region, trial) {
  if (!region) return;
  const doc = region.ownerDocument;
  const opened = new Set([...region.querySelectorAll('[data-style-trial-scene][open]')].map(row => row.dataset.styleTrialScene));
  const focus = doc.activeElement?.hasAttribute?.('data-style-trial-stop') || doc.activeElement?.hasAttribute?.('data-style-trial-generate');
  region.outerHTML = styleTrialMarkup(trial);
  const next = doc.querySelector('[data-style-trial-region]');
  for (const row of next.querySelectorAll('[data-style-trial-scene]')) row.open = opened.has(row.dataset.styleTrialScene);
  if (focus) next.querySelector(trial.busy ? '[data-style-trial-stop]' : '[data-style-trial-generate]')?.focus({ preventScroll: true });
}

// The controller owns only this optional preview. It cannot cancel replies,
// persist settings, learn from feedback, or send WeChat messages.
export function createStyleTrialUI({ api, scope, draft, changed }) {
  let state = {}, active = null;
  const emit = () => changed(state);
  function cancel({ clear = false, stale = false } = {}) {
    const op = active; active = null;
    if (!op && !state.result && !state.busy && !state.error && !state.notice) return;
    if (op) {
      op.controller.abort();
      api(`/instances/${op.instance}/ai`, { action: 'style-trial-cancel', value: { operationId: op.operationId, account: op.account } }, 15000).catch(() => {});
    }
    state = clear ? {} : { ...state, busy: false, stale: stale || state.stale, error: '', notice: op ? '已停止试聊；已发出的上游请求仍可能计费。' : state.notice };
    emit();
  }
  function current(op) {
    const now = scope();
    try { return active === op && now.verified && now.instance === op.instance && now.account === op.account && now.contact === op.contact && now.revision === op.revision && JSON.stringify(draft()) === op.draftKey; }
    catch { return false; }
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
      state = { busy: false, result, stale: false, notice: '', error: '' };
    } catch (error) {
      if (current(op)) state = { ...state, busy: false, error: `${error.message}。风格草稿和上次结果已保留，本次不会自动重试。` };
    } finally { if (active === op) { active = null; state.busy = false; emit(); } }
  }
  return { generate, cancel, value: () => state };
}
