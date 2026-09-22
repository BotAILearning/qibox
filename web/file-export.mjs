export function fileExporter({ call, download, openFolder, show, notify }) {
  async function ready(request, name, signal) {
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
      if (request.count > 1 && window.showDirectoryPicker) directory = await window.showDirectoryPicker({ mode: 'readwrite' });
      else if (request.count === 1 && window.showSaveFilePicker) target = await window.showSaveFilePicker({ suggestedName: name });
      await ready(request, name, signal);
      for (let index = 0; index < request.count; index++) {
        signal.throwIfAborted(); show(`正在保存文件 ${index + 1}/${request.count}…`);
        const response = await download({ action: 'export-download', id: request.id, index, signal });
        const remoteName = decodeURIComponent(/filename\*=UTF-8''([^;]+)/i.exec(response.headers.get('Content-Disposition') || '')?.[1] || '微信文件');
        let file = target;
        if (directory) {
          try { await directory.getFileHandle(remoteName); throw new Error(`目标位置已存在 ${remoteName}，请更换文件夹`); }
          catch (error) { if (error.name !== 'NotFoundError') throw error; }
          file = await directory.getFileHandle(remoteName, { create: true });
        }
        if (file) {
          const writer = await file.createWritable();
          try { await response.body.pipeTo(writer, { signal }); }
          catch (error) { await writer.abort().catch(() => {}); throw error; }
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
