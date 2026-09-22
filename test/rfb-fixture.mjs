// A minimal RFB 3.8 peer for testing the real noVNC browser client and proxy.
// This is a protocol fixture, not a Linux desktop or a WeChat process.
import net from 'node:net';
import sharp from 'sharp';

export async function rfbFixture(wallpaper) {
  const width = 1280, height = 800;
  const pixels = await sharp(wallpaper).resize(width, height).ensureAlpha().raw().toBuffer();
  const keys = [], pointers = [], errors = [], clients = new Set();
  let frames = 0;
  const server = net.createServer(socket => {
    clients.add(socket); socket.on('error', () => {}); socket.on('close', () => clients.delete(socket));
    socket.write('RFB 003.008\n');
    let buffer = Buffer.alloc(0), stage = 'version', sent = false;
    const take = size => { const data = buffer.subarray(0, size); buffer = buffer.subarray(size); return data; };
    const frame = () => {
      const header = Buffer.alloc(16); header[0] = 0; header.writeUInt16BE(2, 2);
      header.writeUInt16BE(width, 8); header.writeUInt16BE(height, 10); // raw encoding = 0
      const cursor = Buffer.alloc(12); cursor.writeInt32BE(-239, 8); // empty server cursor
      socket.write(Buffer.concat([header, pixels, cursor])); frames++; sent = true;
    };
    socket.on('data', data => {
      buffer = Buffer.concat([buffer, data]);
      try {
        while (buffer.length) {
          if (stage === 'version') {
            if (buffer.length < 12) return;
            if (take(12).toString() !== 'RFB 003.008\n') throw new Error('Unexpected RFB version');
            socket.write(Buffer.from([1, 1])); stage = 'security';
          } else if (stage === 'security') {
            if (take(1)[0] !== 1) throw new Error('Unexpected security selection');
            socket.write(Buffer.alloc(4)); stage = 'init';
          } else if (stage === 'init') {
            take(1);
            const name = Buffer.from('Qibox protocol test');
            const init = Buffer.alloc(24); init.writeUInt16BE(width, 0); init.writeUInt16BE(height, 2);
            init[4] = 32; init[5] = 24; init[7] = 1;
            init.writeUInt16BE(255, 8); init.writeUInt16BE(255, 10); init.writeUInt16BE(255, 12);
            init[14] = 0; init[15] = 8; init[16] = 16; init.writeUInt32BE(name.length, 20);
            socket.write(Buffer.concat([init, name])); stage = 'normal';
          } else {
            const type = buffer[0];
            let size = { 0: 20, 2: 4, 3: 10, 4: 8, 5: 6, 6: 8 }[type];
            if (!size) throw new Error(`Unexpected client message ${type}`);
            if (buffer.length < size) return;
            if (type === 2) size += buffer.readUInt16BE(2) * 4;
            if (type === 6) size += buffer.readUInt32BE(4);
            if (buffer.length < size) return;
            const message = take(size);
            if (type === 0 && (message[4] !== 32 || message[6] !== 0 || message[14] !== 0 || message[15] !== 8 || message[16] !== 16)) throw new Error('Unexpected pixel format');
            if (type === 3 && (!sent || !message[1])) frame();
            if (type === 4) keys.push({ down: !!message[1], symbol: message.readUInt32BE(4) });
            if (type === 5) pointers.push({ mask: message[1], x: message.readUInt16BE(2), y: message.readUInt16BE(4) });
          }
        }
      } catch (error) { errors.push(error.message); socket.destroy(); }
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, keys, pointers, errors, get frames() { return frames; },
    disconnect() { for (const client of clients) client.destroy(); },
    async close() { for (const client of clients) client.destroy(); await new Promise(resolve => server.close(resolve)); } };
}
