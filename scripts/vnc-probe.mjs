// Minimal authenticated RFB keyboard client for isolated Linux integration tests.
import net from 'node:net';
import { createCipheriv } from 'node:crypto';
export async function vncProbe(port, password) {
  const socket = net.connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0), pending, failure;
  socket.on('data', bytes => { buffer = Buffer.concat([buffer, bytes]); pending?.(); });
  socket.on('error', error => { failure = error; pending?.(); });
  const read = async count => {
    while (buffer.length < count) {
      if (failure) throw failure;
      await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('RFB timeout')), 5000); pending = () => { clearTimeout(timer); pending = null; resolve(); }; });
    }
    const result = buffer.subarray(0, count); buffer = buffer.subarray(count); return result;
  };
  try {
    await read(12); socket.write('RFB 003.008\n');
    const count = (await read(1))[0], types = await read(count);
    if (!types.includes(2)) throw new Error('VNC password authentication required');
    socket.write(Buffer.from([2]));
    const challenge = await read(16), key = Buffer.alloc(8);
    Buffer.from(password).subarray(0, 8).forEach((b, i) => { for (let n = 0; n < 8; n++) key[i] |= ((b >> n) & 1) << (7 - n); });
    const cipher = createCipheriv('des-ede3', Buffer.concat([key, key, key]), null); cipher.setAutoPadding(false);
    socket.write(Buffer.concat([cipher.update(challenge), cipher.final()]));
    if ((await read(4)).readUInt32BE() !== 0) throw new Error('RFB authentication failed');
    socket.write(Buffer.from([1]));
    const init = await read(24); await read(init.readUInt32BE(20));
    return {
      sendKey(keysym, code, down) { if (down === undefined) { this.sendKey(keysym, code, true); this.sendKey(keysym, code, false); return; } const packet = Buffer.alloc(8); packet[0] = 4; packet[1] = +down; packet.writeUInt32BE(keysym, 4); socket.write(packet); },
      close() { socket.destroy(); },
    };
  } catch (error) { socket.destroy(); throw error; }
}
