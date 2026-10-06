// The browser's real editable element owns OS composition. Only committed text
// reaches RFB; composition keys never reach the NAS input method.
export function sendCommittedText(client, text) {
  for (const character of text) {
    const point = character.codePointAt(0);
    if (point < 32 || point === 127) continue;
    client.sendKey(point > 255 ? (0x01000000 | point) : point);
  }
}

const special = { Backspace: 0xff08, Tab: 0xff09, Enter: 0xff0d, Escape: 0xff1b, Delete: 0xffff,
  Home: 0xff50, ArrowLeft: 0xff51, ArrowUp: 0xff52, ArrowRight: 0xff53, ArrowDown: 0xff54,
  PageUp: 0xff55, PageDown: 0xff56, End: 0xff57, Insert: 0xff63 };
export function nativeInput({ input, screen, client, paste, pasteFiles, notify, connected = () => true, recover = text => { input.value = text; input.classList.add('composing'); }, mac = false, touch = false }) {
  let composing = false, ended = null, disposed = false, pending = Promise.resolve(), blocked = 0, epoch = 0;
  let failed = false, retained = '';
  let pendingCommit = null;
  let anchor = { x: 0, y: 0 };
  const listeners = [];
  const listen = (target, type, handler, options) => { target.addEventListener(type, handler, options); listeners.push(() => target.removeEventListener(type, handler, options)); };
  const clear = () => { input.value = ''; input.classList.remove('composing'); };
  const position = () => {
    const box = screen.getBoundingClientRect();
    // Reserve the same space before and during composition so native candidates
    // don't jump when the textarea becomes visible or overflow the right edge.
    input.style.left = `${Math.max(0, Math.min(box.width - 250, anchor.x))}px`;
    input.style.top = `${Math.max(0, Math.min(box.height - 36, anchor.y))}px`;
  };
  const enqueue = (action, text = '', settled = () => {}) => {
    if (!text) pendingCommit = null;
    const queuedEpoch = epoch;
    if (text) blocked++;
    pending = pending.then(async () => {
      if (disposed || failed || queuedEpoch !== epoch || !connected()) throw new Error('输入未完成，请核对微信草稿');
      await action();
    }).catch(error => {
      const firstFailure = queuedEpoch === epoch;
      if (firstFailure) epoch++;
      if (text) { failed = true; retained += typeof text === 'object' ? text.value : text; recover(retained); }
      if (!disposed && firstFailure) notify(error.message || '输入未完成，请核对微信草稿');
    }).finally(() => { if (text) blocked--; settled(); });
  };
  const chord = (symbol, event = {}) => {
    const modifiers = [];
    if (event.ctrlKey || (mac && event.metaKey)) modifiers.push([0xffe3, 'ControlLeft']);
    if (event.altKey && !mac) modifiers.push([0xffe9, 'AltLeft']);
    if (event.shiftKey) modifiers.push([0xffe1, 'ShiftLeft']);
    try {
      for (const [key, code] of modifiers) client.sendKey(key, code, true);
      client.sendKey(symbol);
    } finally {
      for (const [key, code] of modifiers.reverse()) {
        try { client.sendKey(key, code, false); } catch {}
      }
    }
  };
  const performPaste = async text => {
    const activeEpoch = epoch;
    const result = await paste(text);
    if (disposed || activeEpoch !== epoch || !connected()) throw new Error('输入未完成，请核对微信草稿');
    if (result?.pasteRequired !== false) chord(0x76, { ctrlKey: true });
  };
  const pasteText = text => {
    if (!text) return;
    if (new TextEncoder().encode(text).length > 60000) { notify('文字过长，请分段粘贴'); return; }
    pendingCommit = null;
    enqueue(() => performPaste(text), text);
  };
  // Commit IME/Unicode through the instance's private clipboard. A Unicode
  // keysym can be silently ignored by the remote application/input method.
  const commit = text => {
    if (!text) return;
    if (new TextEncoder().encode(text).length > 60000) { notify('文字过长，请分段粘贴'); return; }
    // Adjacent committed fragments queued during a native paste form one
    // insertion. Do not launch a clipboard owner for every fast typed glyph.
    if (pendingCommit && pendingCommit.epoch === epoch && new TextEncoder().encode(pendingCommit.value + text).length <= 60000) {
      pendingCommit.value += text; return;
    }
    const batch = { value: text, epoch }; pendingCommit = batch;
    enqueue(async () => {
      if (pendingCommit === batch) pendingCommit = null;
      if (/[^\x20-\x7e]/.test(batch.value)) await performPaste(batch.value);
      else sendCommittedText(client, batch.value);
    }, batch);
  };
  const pasteLocalFiles = files => {
    if (!pasteFiles) { notify('当前连接暂不支持文件粘贴'); return; }
    blocked++;
    enqueue(async () => {
      const activeEpoch = epoch;
      const result = await pasteFiles(files);
      if (disposed || activeEpoch !== epoch || !connected()) throw new Error('文件未粘贴，请回到微信重新粘贴');
      if (result?.pasteRequired !== false) chord(0x76, { ctrlKey: true });
      notify('文件已粘贴，请在微信中确认发送');
    }, '', () => { blocked--; });
  };
  input.hidden = false; client.focusOnClick = false;
  listen(input, 'compositionstart', () => { composing = true; ended = null; position(); input.classList.add('composing'); });
  listen(input, 'compositionend', event => { composing = false; ended = event.data || ''; commit(event.data); clear(); });
  listen(input, 'input', event => {
    if (composing || event.isComposing) return;
    // Browsers may emit the final input before or after compositionend.
    if (ended !== null && (event.data === ended || event.inputType === 'insertCompositionText' || event.inputType === 'insertFromComposition')) { ended = null; clear(); return; }
    ended = null;
    const text = input.value || event.data || '';
    if (/[\r\n\t]/.test(text)) pasteText(text); else commit(text);
    clear();
  });
  listen(input, 'beforeinput', event => {
    if (composing || event.isComposing) return;
    // Chromium can emit separate input events for every line in one committed
    // insertion. Capture it before mutation so clearing the host textarea does
    // not replay the trailing lines (for example dictation / inserted text).
    if (event.inputType === 'insertText' && /[\r\n\t]/.test(event.data || '')) {
      event.preventDefault(); ended = null; pasteText(event.data); clear(); return;
    }
    const key = { deleteContentBackward: 0xff08, deleteContentForward: 0xffff }[event.inputType];
    if (key) { event.preventDefault(); enqueue(() => chord(key)); }
  });
  listen(input, 'keydown', event => {
    if (composing || event.isComposing || event.keyCode === 229 || event.key === 'Process') return;
    ended = null;
    // Leave OS IME switching, dead keys, AltGr and printable input to the host.
    if (['Shift', 'Control', 'Alt', 'Meta', 'Dead', 'Unidentified'].includes(event.key)) return;
    if ((event.code === 'Space' && (event.ctrlKey || event.metaKey)) || (event.metaKey && !mac) || event.getModifierState?.('AltGraph')) return;
    const shortcut = event.ctrlKey || (mac && event.metaKey);
    if ((shortcut && event.key.toLowerCase() === 'v') || (event.shiftKey && event.key === 'Insert')) return;
    let symbol = special[event.key];
    if (/^F(?:[1-9]|1[0-2])$/.test(event.key)) symbol = 0xffbd + Number(event.key.slice(1));
    if (shortcut && event.key.length === 1) symbol = event.key.toLowerCase().codePointAt(0);
    if (!symbol) return;
    event.preventDefault(); enqueue(() => chord(symbol, event));
  });
  listen(input, 'paste', event => {
    event.preventDefault();
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      pasteLocalFiles(files);
      clear();return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (!text) { notify('请粘贴文字内容'); return; }
    pasteText(text); clear();
  });
  listen(input, 'blur', () => {
    if (blocked) epoch++;
    const draft = composing ? input.value : ''; composing = false; ended = null; clear();
    if (draft) { retained += draft; failed = true; }
    if (retained) recover(retained);
  });
  const focus = event => {
    if (disposed || touch || event.button > 0) return;
    const box = screen.getBoundingClientRect();
    if (!composing) { anchor = { x: event.clientX - box.left, y: event.clientY - box.top }; position(); }
    input.focus({ preventScroll: true });
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null;
  observer?.observe(screen);
  const localControl = event => event.target !== input && event.target.closest?.('#file-transfer, #input-recovery, button, input, textarea, select, a, dialog');
  for (const type of ['pointerdown', 'touchstart', 'wheel']) listen(screen, type, event => {
    if (blocked && !localControl(event)) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, passive: false });
  listen(screen, 'dragover', event => { if (!localControl(event)) event.preventDefault(); });
  listen(screen, 'drop', event => {
    if (localControl(event)) return;
    event.preventDefault();
    if (blocked) { notify('正在准备粘贴内容，请稍候'); return; }
    const files = [...(event.dataTransfer?.files || [])];
    if (files.length) pasteLocalFiles(files);
    else {
      const text = event.dataTransfer?.getData('text/plain');
      if (text) pasteText(text);
    }
  });
  listen(screen, 'mousedown', event => {
    if (localControl(event)) return;
    // A text paste must finish before a click changes the remote field.
    if (blocked) { event.preventDefault(); event.stopImmediatePropagation(); return; }
    // Keep the host textarea focused after the browser's default canvas focus
    // action. The pointer event still reaches noVNC and the remote comment field.
    if (!touch && event.button === 0 && event.target.tagName === 'CANVAS') event.preventDefault();
    focus(event);
  }, true);
  listen(screen, 'mouseup', event => { if (!blocked && !localControl(event)) focus(event); }, true);
  listen(screen, 'touchend', event => { if (!blocked && event.changedTouches?.[0]) focus(event.changedTouches[0]); }, true);
  // Canvas focus from noVNC touch handling / Tab still goes through the host IME.
  listen(screen, 'focusin', event => { if (!touch && event.target.tagName === 'CANVAS') input.focus({ preventScroll: true }); });
  return { focus: () => input.focus({ preventScroll: true }), flush: () => pending,
    pause() { epoch++; failed = true; },
    resume() { epoch++; retained = ''; failed = false; clear(); },
    dispose() { if (composing && input.value) { retained += input.value; recover(retained); } disposed = true; epoch++; observer?.disconnect(); listeners.forEach(remove => remove()); clear(); input.hidden = true; } };
}
