// Keep the original WeChat button: its private portal requests a browser picker.
// The recent pointer/key gesture provides transient activation for showPicker.
import { fileExporter } from './file-export.mjs';
export function localFiles({ screen, input, panel, api, upload, download, openFolder, notify, focus, pickNas }) {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('');
  const client = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  let disposed = false, current = null, timer, checking = false, activeUntil = 0, pointerArmed = false, picked = false, controller;
  const label = panel.querySelector('[data-file-status]'), choose = panel.querySelector('[data-file-choose]'), cancel = panel.querySelector('[data-file-cancel]'), progress = panel.querySelector('progress');
  const nas = panel.querySelector('[data-file-nas]');
  const nameInput = panel.querySelector('[data-file-name]'), destinationHelp = panel.querySelector('[data-file-destination-help]');
  if (nas) nas.hidden = !pickNas;
  const call = (action, data = {}) => api({ action, client, ...data });
  const show = message => { if (!disposed) { label.textContent = message; panel.hidden = false; } };
  const hide = (force = false) => { if (disposed && !force) return; panel.hidden = true; progress.hidden = true; choose.hidden = false; input.value = ''; picked = false; };
  const schedule = delay => { clearTimeout(timer); if (!disposed) timer = setTimeout(check, delay); };
  const exporter = fileExporter({ call, download: value => download({ ...value, client }), openFolder, show, notify });
  const present = () => {
    const exporting = !!current.operation, folder = current.operation === 'folder';
    choose.textContent = folder ? '打开 NAS 目录' : exporting ? '保存到当前设备' : '选择本地文件';
    if (nas) { nas.hidden = !pickNas || folder; nas.textContent = exporting ? '保存到 NAS' : '选择 NAS 文件'; }
    if (nameInput) { nameInput.hidden = !exporting || folder || current.count > 1; nameInput.value = current.name || ''; }
    if (destinationHelp) destinationHelp.hidden = !exporting || folder;
    show(folder ? '打开文件所在目录' : exporting ? `选择保存位置 · ${current.count} 个文件` : '选择文件来源');
  };
  const exportWork = async operation => {
    if (!current || controller || disposed) return;
    const request = current, transfer = controller = new AbortController();
    choose.disabled = true; if (nas) nas.disabled = true;
    try {
      await operation(request, nameInput?.value || request.name, transfer.signal);
      if (disposed || current !== request || controller !== transfer) return;
      current = null; controller = null; hide(); focus?.();
    } catch (error) {
      if (current === request && controller === transfer) { controller = null; present(); }
      if (!disposed && !transfer.signal.aborted && error.name !== 'AbortError') notify(error.message || '保存未完成，请重试');
    } finally { choose.disabled = false; if (nas) nas.disabled = false; }
  };
  const open = () => {
    if (!current || picked || disposed) return;
    if (current.operation) { void exportWork((...args) => exporter.local(...args)); return; }
    input.multiple = current.multiple; input.value = '';
    try {
      // File pickers work on HTTP and in NAS iframes; do not require the
      // secure-context File System Access API or mount the user's folders.
      if (input.showPicker) input.showPicker(); else input.click();
      picked = true; show('选择要发送的文件');
    } catch { show('选择要发送的文件'); choose.focus(); }
  };
  async function check() {
    if (disposed || checking) return;
    checking = true;
    try {
      const result = await call('state');
      if (disposed) return;
      if (!result.available) { if (current) await abort(current); schedule(2000); return; }
      if (!result.request) {
        if (current && !controller) { current = null; hide(); }
      } else if (!current && document.hasFocus() && Date.now() < activeUntil) {
        const claimed = await call('claim', { id: result.request.id });
        if (disposed) { await call('cancel', { id: result.request.id }).catch(() => {}); return; }
        current = claimed.request;
        if (current) { activeUntil = 0; present(); }
      }
    } catch { /* A brief disconnect must not trigger extra pickers or messages. */ }
    finally { checking = false; schedule(Date.now() < activeUntil ? 100 : 750); }
  }
  const gesture = event => {
    if (event.isTrusted === false || (event.button !== undefined && event.button !== 0)) return;
    if (event.type === 'pointerup') { if (!pointerArmed) return; pointerArmed = false; }
    activeUntil = Date.now() + 4500;
    schedule(30);
  };
  const abort = async (request = current) => {
    const ownsCurrent = current === request;
    if (ownsCurrent) { current = null; controller?.abort(); controller = null; hide(); }
    if (request) await call('cancel', { id: request.id }).catch(() => {});
    if (ownsCurrent && !disposed && !current) focus?.();
  };
  const cancelCurrent = () => { void abort(current); };
  const changed = async () => {
    const request = current, files = [...input.files];
    if (!request || disposed) return;
    if (!files.length) { picked = false; show('选择文件来源'); return; }
    const transfer = controller = new AbortController(), signal = transfer.signal;
    choose.hidden = true; if (nas) nas.disabled = true; progress.hidden = false; progress.value = 0;
    const total = files.reduce((size, file) => size + file.size, 0);
    try {
      if (files.length > request.maxFiles || files.some(file => file.size > request.maxFileBytes) || total > request.maxBatchBytes) throw new Error('文件过多或过大，请减少后重新选择');
      const plan = await call('plan', { id: request.id, files: files.map(file => ({ name: file.name, size: file.size })) });
      let completed = 0;
      for (let i = 0; i < files.length; i++) {
        signal.throwIfAborted();
        show(`正在准备文件 ${i + 1}/${files.length}`);
        await upload({ requestId: request.id, fileId: plan.files[i].id, client, file: files[i], signal,
          progress: loaded => { if (!disposed && current === request && controller === transfer && !signal.aborted) { progress.value = total ? Math.floor((completed + loaded) / total * 100) : 100; show(`正在上传 ${files[i].name} · ${Math.round((completed + loaded) / 1024)} / ${Math.round(total / 1024)} KB`); } } });
        completed += files[i].size;
      }
      signal.throwIfAborted();
      await call('complete', { id: request.id });
      if (disposed || current !== request || controller !== transfer || signal.aborted) return;
      current = null; controller = null; hide();
      if (!disposed) { notify('文件已准备好，请在微信中确认发送'); focus?.(); }
    } catch (error) {
      const wasCancelled = signal.aborted;
      await abort(request);
      if (!disposed && !wasCancelled) notify(error.message || '文件未传完，请重新选择');
    } finally { if (nas) nas.disabled = false; }
  };
  const pickerCancelled = () => { picked = false; if (current) show('选择文件来源'); };
  const chooseNas = () => {
    if (!current || controller || disposed) return;
    void Promise.resolve(pickNas?.({ id: current.id, client, exporting: !!current.operation })).catch(error => { notify(error.message); pickerCancelled(); });
  };
  const selectNas = async (paths, context) => {
    if (disposed || !current || current.id !== context.id || client !== context.client || controller) throw new Error('文件选择已结束，请重新点击发送文件');
    const request = current, transfer = controller = new AbortController();
    choose.hidden = true; if (nas) nas.disabled = true; progress.hidden = false; progress.removeAttribute('value'); show('正在准备 NAS 文件…');
    try {
      await call('nas', { id: request.id, paths });
      if (disposed || current !== request || controller !== transfer) return;
      current = null; controller = null; hide(); notify('文件已准备好，请在微信中确认发送'); focus?.();
    } catch (error) { await abort(request); if (!disposed && !transfer.signal.aborted) notify(error.message); }
    finally { if (nas) nas.disabled = false; }
  };
  const selectExportNas = async (path, context) => {
    if (disposed || !current?.operation || current.id !== context.id || client !== context.client || controller) throw new Error('文件保存已结束，请从微信重新操作');
    return exportWork((request, name, signal) => exporter.nas(request, name, path, signal));
  };
  input.addEventListener('change', changed);
  input.addEventListener('cancel', pickerCancelled);
  // noVNC captures the release on a body-level overlay, then forwards an
  // untrusted mouseup. Retain only the genuine pointer gesture begun here.
  const armPointer = event => { if (event.isTrusted && event.button === 0 && !panel.contains(event.target)) pointerArmed = true; };
  const cancelPointer = () => { pointerArmed = false; };
  screen.addEventListener('pointerdown', armPointer, true);
  window.addEventListener('pointerup', gesture, true);
  window.addEventListener('pointercancel', cancelPointer, true);
  screen.addEventListener('keyup', gesture, true);
  choose.addEventListener('click', open);
  nas?.addEventListener('click', chooseNas);
  cancel.addEventListener('click', cancelCurrent);
  // Block remote keyboard/pointer input while selecting/uploading, preserving
  // the chat that requested the files until WeChat shows its own confirmation.
  const block = event => {
    if (!current || panel.contains(event.target)) return;
    event.preventDefault(); event.stopImmediatePropagation();
  };
  // Let a release reach noVNC even when a chooser opened after its mousedown.
  // Blocking the release leaves the remote button and capture proxy held down.
  const blockedEvents = ['pointerdown', 'mousedown', 'keydown', 'keyup', 'beforeinput', 'paste'];
  for (const type of blockedEvents) screen.addEventListener(type, block, true);
  schedule(750);
  return { selectNas, selectExportNas, dispose() {
    if (disposed) return;
    disposed = true; clearTimeout(timer); void abort(current); hide(true);
    input.removeEventListener('change', changed); input.removeEventListener('cancel', pickerCancelled);
    screen.removeEventListener('pointerdown', armPointer, true); window.removeEventListener('pointerup', gesture, true); window.removeEventListener('pointercancel', cancelPointer, true); screen.removeEventListener('keyup', gesture, true);
    choose.removeEventListener('click', open); cancel.removeEventListener('click', cancelCurrent);
    nas?.removeEventListener('click', chooseNas);
    for (const type of blockedEvents) screen.removeEventListener(type, block, true);
  } };
}
