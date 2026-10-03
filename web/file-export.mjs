import { writeClipboardText } from './clipboard-write.mjs';

function selection(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function fileExporter({ call, download, openFolder, show, notify }) {
  const clipboardCache = new Map();
  async function ready(request, name, signal) {
    signal.throwIfAborted();
    if (request.operation !== 'save') return;
    await call('export-start', { id: request.id, name });
    const deadline = Date.now() + 10 * 60 * 1000;
    for (;;) {
      signal.throwIfAborted();
      const state = await call('state');
      if (state.request?.id !== request.id) throw new Error('文件保存已结束，请从微信重新操作');
      if (state.request.ready) return;
      if (Date.now() > deadline) throw new Error('等待微信保存超时，请重新操作');
      show('正在等待微信保存完成…');
      await new Promise(resolve => setTimeout(resolve, 350));
    }
  }
  return {
    discard(id) { clipboardCache.delete(id); },
    dispose() { clipboardCache.clear(); },
    async clipboard(request, signal) {
      if (request.clipboardType === 'files') throw new Error('请选择文件保存位置');
      if (request.clipboardType === 'text') {
        let text = clipboardCache.get(request.id);
        if (!text) {
          text = (async () => {
            const response = await download({ action: 'export-download', id: request.id, index: 0, signal });
            const value = await response.text();
            if (!value || value.includes('\0') || new TextEncoder().encode(value).length > 60000) throw new Error('复制内容无效，请在微信中重新复制');
            return value;
          })();
          clipboardCache.set(request.id, text);
          text.catch(() => clipboardCache.delete(request.id));
        }
        await writeClipboardText(await text, { signal });
        signal.throwIfAborted();
        await call('export-finish', { id: request.id });
        clipboardCache.delete(request.id);
        notify('文字已复制到本机，可在其他应用中粘贴');
        return;
      }
      if (!globalThis.isSecureContext || !navigator.clipboard?.write || !globalThis.ClipboardItem) {
        throw new Error('此连接无法写入图片剪贴板；可保存图片，或通过 HTTPS 打开栖盒后复制');
      }
      if (request.count !== 1) throw new Error('一次只能复制一张图片');
      if (!document.hasFocus()) throw new Error('请回到微信页面，点击“复制到本机”');
      // Start the write while the WeChat menu click still has user activation.
      // Chromium accepts a promised PNG blob while the NAS image is fetched.
      const png = (async () => {
        signal.throwIfAborted();
        const response = await download({ action: 'export-download', id: request.id, index: 0, signal });
        const blob = await response.blob();
        if (blob.size > 20 * 1024 * 1024) throw new Error('图片超过 20 MB，请保存到当前设备');
        signal.throwIfAborted();
        const image = await createImageBitmap(blob);
        try {
          if (image.width * image.height > 24000000) throw new Error('图片尺寸过大，请保存到当前设备');
          const canvas = document.createElement('canvas');
          canvas.width = image.width; canvas.height = image.height;
          canvas.getContext('2d').drawImage(image, 0, 0);
          const png = await new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('图片转换失败')), 'image/png'));
          signal.throwIfAborted();
          if (!document.hasFocus()) throw new Error('请回到微信页面，点击“复制到本机”');
          return png;
        } finally { image.close(); }
      })();
      // ClipboardItem may reject before consuming its promised image.
      png.catch(() => {});
      try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]); }
      catch (error) {
        signal.throwIfAborted();
        throw new Error('图片已准备好，请点击“复制到本机”，或选择保存图片');
      }
      signal.throwIfAborted();
      await call('export-finish', { id: request.id });
      notify('图片已复制到当前设备剪贴板');
    },
    async local(request, name, signal) {
      let target, directory;
      if (request.operation === 'folder') {
        const result = await call('export-folder', { id: request.id });
        if (!openFolder) throw new Error(`文件位于 NAS：${result.path}`);
        await openFolder(result.path);
        await call('export-finish', { id: request.id });
        notify('已请求打开 NAS 中的文件所在目录'); return;
      }
      // Open the picker in the original trusted click before awaiting the NAS.
      signal.throwIfAborted();
      if (request.count > 1 && window.showDirectoryPicker) directory = await selection(window.showDirectoryPicker({ mode: 'readwrite' }), signal);
      else if (request.count === 1 && window.showSaveFilePicker) target = await selection(window.showSaveFilePicker({ suggestedName: name }), signal);
      await ready(request, name, signal);
      for (let index = 0; index < request.count; index++) {
        signal.throwIfAborted(); show(`正在保存文件 ${index + 1}/${request.count}…`);
        const response = await download({ action: 'export-download', id: request.id, index, signal });
        const remoteName = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') || '')?.[1] || '微信文件');
        let file = target, created = false;
        if (directory) {
          try { await directory.getFileHandle(remoteName); throw new Error(`目标位置已存在 ${remoteName}，请更换文件夹`); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
          file = await directory.getFileHandle(remoteName, { create: true }); created = true;
        }
        if (file) {
          const writer = await file.createWritable();
          try { await response.body.pipeTo(writer, { signal }); }
          catch (error) {
            await writer.abort().catch(() => {});
            if (created) await directory.removeEntry(remoteName).catch(() => {});
            throw error;
          }
        } else {
          const blob = await response.blob(); signal.throwIfAborted();
          const url = URL.createObjectURL(blob), anchor = document.createElement('a');
          anchor.href = url; anchor.download = request.count === 1 ? name : remoteName;
          document.body.append(anchor); anchor.click(); anchor.remove();
          setTimeout(() => URL.revokeObjectURL(url), 60000);
        }
      }
      await call('export-finish', { id: request.id });
      notify(target || directory ? '文件已保存到所选位置' : '已交给浏览器下载，请在下载列表确认；保存位置由浏览器设置决定');
    },
    async nas(request, name, path, signal) {
      await ready(request, name, signal); signal.throwIfAborted(); show('正在保存到 NAS…');
      const result = await call('export-nas', { id: request.id, name, path });
      notify(`已保存到 ${result.saved.length === 1 ? result.saved[0].path : path}`);
    },
  };
}
