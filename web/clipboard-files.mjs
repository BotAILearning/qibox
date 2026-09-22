export async function clipboardFiles(files) {
  if (!files.length || files.length > 10 || files.reduce((size,f)=>size+f.size,0)>20*1024*1024) throw new Error('一次最多粘贴 10 个文件，合计不超过 20 MB');
  return Promise.all(files.map(async file => {
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary='';
    for(let i=0;i<bytes.length;i+=8192) binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
    return {name:file.name || '图片.png',type:file.type || 'application/octet-stream',data:btoa(binary)};
  }));
}
