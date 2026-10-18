const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const size = value => {
  if (!Number.isFinite(value) || value < 0) return '暂不可确认';
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${Math.round(value)} 字节`;
};

const stages = [
  ['checking', '检查本机环境'],
  ['verifying', '校验随包资源'],
  ['extracting', '展开缺少文件'],
  ['selftest', '自检运行环境'],
  ['ready', '准备完成'],
];
const stageMessages = {
  checking: '检查 NAS 本机已有环境与安装包资源',
  verifying: '校验随栖盒安装包提供的运行资源',
  extracting: '正在展开本机缺少的运行文件',
  selftest: '正在检查运行环境是否可用',
  ready: '运行环境已准备就绪',
};

function clientMarkup(library) {
  const installed = library?.installed;
  if (installed) {
    const version = installed.version ? `（${esc(installed.version)}）` : '';
    return `<section class="preparation-client" aria-label="官方微信客户端"><div><h5>官方微信客户端</h5><p>客户端已安装${version}，准备完成后将复用现有安装。</p></div><span class="preparation-client-state">可复用</span></section>`;
  }

  const remaining = library?.remainingDownloadSize;
  const total = library?.downloadSize;
  let detail;
  if (Number.isFinite(remaining) && remaining >= 0) {
    detail = `当前剩余下载量 <strong>${size(remaining)}</strong>${Number.isFinite(total) && total >= 0 ? ` <span>（版本总量 ${size(total)}）</span>` : ''}`;
  } else if (Number.isFinite(total) && total >= 0) {
    detail = `版本总量 ${size(total)}；当前剩余量暂不可确认`;
  } else {
    detail = '选择官方客户端版本后显示实际下载量，也可导入已有的官方安装包。';
  }
  return `<section class="preparation-client" aria-label="官方微信客户端"><div><h5>官方微信客户端</h5><p>微信客户端单独从官方渠道获取，也可以导入已有安装包。</p></div><p class="preparation-client-size">${detail}</p></section>`;
}

export function preparationMarkup(state, library, { importing = false, importError = '' } = {}) {
  if (!state || state.status === 'ready' && library?.installed) return '';
  const working = state.status === 'working';
  const paused = state.status === 'paused';
  const failed = state.status === 'error';
  const ready = state.status === 'ready';
  const stage = stageMessages[state.stage] ? state.stage : ready ? 'ready' : 'checking';
  const localSize = Number.isFinite(state.total) ? size(state.total) : '暂不可确认';
  const pendingSize = Number.isFinite(state.remaining) ? size(state.remaining) : '暂不可确认';
  const reuseCount = Number.isFinite(state.details?.reusedFiles) ? state.details.reusedFiles : 0;
  const activeStatus = ready ? stageMessages.ready : working ? stageMessages[stage] : paused ? '本机准备待继续' : failed ? '准备未完成，可修复后重试' : stageMessages.checking;

  return `<section class="wechat-preparation qi-settings-form" aria-label="准备微信" ${working || importing ? 'aria-busy="true"' : ''}>
    <header class="preparation-heading"><div><span class="preparation-eyebrow">NAS 本机准备</span><h4>准备微信</h4><p>运行环境随栖盒安装包提供。NAS 本机校验并补齐缺项，完成后自检。</p></div><span class="preparation-status ${failed ? 'is-error' : ready ? 'is-ready' : ''}" role="status">${activeStatus}</span></header>
    <ol class="preparation-stages" aria-label="本机准备步骤">${stages.map(([key, label]) => `<li ${stage === key ? 'aria-current="step"' : ''}>${label}</li>`).join('')}</ol>
    ${working ? `<p class="preparation-current" role="status">当前阶段：${stageMessages[stage]}。准备在 NAS 后台运行，关闭页面后会继续。</p>` : ''}
    ${paused ? '<p class="preparation-current" role="status">点击继续后会重新检查；已随包资源和当前运行环境会保留。</p>' : ''}
    ${!working && !paused && !failed && !ready ? '<p class="preparation-current">运行资源随栖盒安装包提供。开始后会在 NAS 本机校验资源、补齐缺少文件并自检。</p>' : ''}
    ${failed ? `<p class="preparation-error" role="alert">${esc(state.error || '本机准备未完成，请重试或导入离线环境包。')}</p>` : ''}
    ${importError ? `<p class="preparation-error" role="alert">离线环境包导入失败：${esc(importError)}。原有数据和环境保持不变，可修复后重试或重新导入。</p>` : ''}
    ${importing ? '<p class="preparation-current" role="status">正在导入并校验离线环境包；完成校验后即可继续准备。</p>' : ''}
    ${clientMarkup(library || {})}
    <div class="preparation-actions">
      ${!ready ? `<button type="button" class="primary" data-preparation="start" ${working || importing ? 'hidden' : ''} ${importing ? 'disabled' : ''}>${paused ? '继续本机准备' : failed ? '重试准备' : '开始本机准备'}</button>` : '<p class="preparation-ready-note">运行环境已就绪，可继续安装官方微信客户端。</p>'}
      <button type="button" class="quiet" data-preparation="offline" ${working || importing ? 'disabled' : ''}>${importing ? '正在导入…' : '导入离线环境包'}</button>
    </div>
    <details class="preparation-details"><summary>查看资源校验与恢复详情</summary><dl><dt>本机运行资源</dt><dd>随栖盒安装包提供；缺项从本地资源中校验和展开</dd><dt>本轮资源量</dt><dd>${localSize}</dd><dt>待修复资源量估算</dt><dd>${pendingSize}</dd><dt>已复用系统文件</dt><dd>${reuseCount.toLocaleString('zh-CN')} 个</dd><dt>本轮待处理资源数</dt><dd>${Number.isFinite(state.details?.missingResources) ? state.details.missingResources : '暂不可确认'}</dd><dt>设备架构</dt><dd>${esc(state.architecture || '暂不可确认')}</dd></dl><p>资源量是本地资源检查结果，不表示准备进度或自检结论。可导入与当前版本、设备架构匹配的完整离线环境包。系统会校验包及内部资源，再展开缺少文件并自检；校验失败时不会替换现有环境。</p><p>准备过程在 NAS 后台运行，关闭页面不会中断。此流程不会清除微信账号资料、聊天数据、模型配置或现有设置。</p><p>环境准备完成后，官方微信客户端仍按独立步骤下载安装或导入；已安装且有效的客户端会直接复用。</p></details>
  </section>`;
}
