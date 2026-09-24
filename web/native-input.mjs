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
  let composing = false, ended = null, disposed = false, pending = Promise.resolve(), blocked = 0;
  let failed = false, retained = '';
  let anchor = { x: 0, y: 0 };
  const listeners = [];
  const listen = (target, type, handler, options) => { target.addEventListener(type, handler, options); listeners.push(() => target.removeEventListener(type, handler, options)); };
  const clear = () => { input.value = ''; input.classList.remove('composing'); };
  const retain = text => {
    if (!text) return;
    retained += text;
    recover(retained);
    failed = true;
  };
  const position = () => {
    const box = screen.getBoundingClientRect();
    // Reserve the same space before and during composition so native candidates
    // don't jump when the textarea becomes visible or overflow the right edge.
    input.style.left = `${Math.max(0, Math.min(box.width - 250, anchor.x))}px`;
    input.style.top = `${Math.max(0, Math.min(box.height - 36, anchor.y))}px`;
  };
  const enqueue = (action, text = '', settled = () => {}) => {
    if (text) blocked++;
    pending = pending.then(async () => {
      if (disposed || failed || !connected()) throw new Error('输入未完成，请核对微信草稿');
      await action();
    }).catch(error => {
      failed = true;
      if (text) retain(text);
      if (!disposed) notify(error.message || '输入未完成，请核对微信草稿');
    }).finally(() => { if (text) blocked--; settled(); });
  };
  const chord = (symbol, event = {}) => {
    const modifiers = [];
    if (event.ctrlKey || (mac && event.metaKey)) modifiers.push([0xffe3, 'ControlLeft']);
    if (event.altKey && !mac) modifiers.push([0xffe9, 'AltLeft']);
    if (event.shiftKey) modifiers.push([0xffe1, 'ShiftLeft']);
    for (const [key, code] of modifiers) client.sendKey(key, code, true);
    client.sendKey(symbol);
    for (const [key, code] of modifiers.reverse()) client.sendKey(key, code, false);
  };
  const pasteText = text => {
    if (!text) return;
    if (new TextEncoder().encode(text).length > 60000) { notify('文字过长，请分段粘贴'); return; }
    enqueue(async () => {
      await paste(text);
      if (disposed || !connected()) throw new Error('连接已断开，请核对微信草稿');
      chord(0x76, { ctrlKey: true });
    }, text);
  };
  // Commit IME/Unicode through the instance's private clipboard. A Unicode
  // keysym can be silently ignored by the remote application/input method.
  const commit = text => { if (text) { if (/[^\x20-\x7e]/.test(text)) pasteText(text); else enqueue(() => sendCommittedText(client, text), text); } };
  input.hidden = false; client.focusOnClick = false;
  listen(input, 'compositionstart', () => { composing = true; ended = null; position(); input.classList.add('composing'); });
  listen(input, 'compositionend', event => {
    const committed = event.data || '';
    const cancelledDraft = !committed && input.value;
    composing = false; ended = committed;
    clear();
    if (committed) commit(committed);
    else retain(cancelledDraft);
  });
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
      if(!pasteFiles) { notify('当前连接暂不支持文件粘贴'); return; }
      blocked++;
      enqueue(async () => {
          await pasteFiles(files);
          if(disposed || !connected()) throw new Error('连接已断开，请重新粘贴文件');
          chord(0x76,{ctrlKey:true});
      }, '', () => { blocked--; });
      clear();return;
    }
    const text = event.clipboardData?.getData('text/plain');
    if (!text) { notify('请粘贴文字内容'); return; }
    pasteText(text); clear();
  });
  listen(input, 'blur', () => { const draft = composing ? input.value : ''; composing = false; ended = null; clear(); retain(draft); });
  const focus = event => {
    if (disposed || touch || event.button > 0) return;
    const box = screen.getBoundingClientRect();
    if (!composing) { anchor = { x: event.clientX - box.left, y: event.clientY - box.top }; position(); }
    input.focus({ preventScroll: true });
  };
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(position) : null;
  observer?.observe(screen);
  const localControl = event => event.target !== input && event.target.closest?.('#file-transfer, #input-recovery, button, input, textarea, select, a, dialog');
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
    pause() { failed = true; },
    resume() { retained = ''; failed = false; clear(); },
    dispose() {
      const draft = composing ? input.value : '';
      composing = false; disposed = true; observer?.disconnect(); listeners.forEach(remove => remove()); clear();
      retain(draft); input.hidden = true;
    } };
}
