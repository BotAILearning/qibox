// Count bytes at the NAS. A short rolling window also lets a stalled transfer
// report zero without a timer or further incoming chunks.
export class TransferProgress {
  constructor(total, now = () => performance.now()) {
    this.total = total || null; this.now = now; this.startedAt = now(); this.bytes = 0; this.buckets = [];
  }
  prune(at) {
    while (this.buckets.length && this.buckets[0].at + 100 <= at - 3000) this.buckets.shift();
  }
  receive(length) {
    const at = this.now(), bucketAt = Math.floor(at / 100) * 100;
    this.bytes += length; this.prune(at);
    const last = this.buckets.at(-1);
    if (last?.at === bucketAt) last.bytes += length;
    else this.buckets.push({ at: bucketAt, bytes: length });
  }
  snapshot() {
    const at = this.now(); this.prune(at);
    const elapsed = Math.min(3000, at - this.startedAt);
    return {
      bytes: this.bytes, total: this.total,
      progress: this.total ? Math.floor(this.bytes / this.total * 100) : null,
      bytesPerSecond: elapsed >= 100 ? Math.round(this.buckets.reduce((sum, item) => sum + item.bytes, 0) * 1000 / elapsed) : null
    };
  }
}

// The extractor emits bounded JSON lines, followed by one metadata result.
// Stream boundaries may split a line, or contain many updates at once.
export class ExtractionOutput {
  constructor(onProgress) { this.onProgress = onProgress; this.buffer = ''; this.result = null; }
  push(text) {
    this.buffer += text;
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
      if (line.trim()) this.line(line);
    }
    if (this.buffer.length > 16384) throw new Error('Invalid extraction output');
  }
  line(line) {
    if (line.length > 16384 || this.result) throw new Error('Invalid extraction output');
    const event = JSON.parse(line);
    if (event.type === 'progress') {
      if (event.stage !== 'extracting' || !Number.isSafeInteger(event.bytes) || !Number.isSafeInteger(event.total) || event.bytes < 0 || event.total < event.bytes || event.total > 3 * 1024 ** 3) throw new Error('Invalid extraction progress');
      this.onProgress?.(event);
    } else if (typeof event.version === 'string' && typeof event.binary === 'string') this.result = event;
    else throw new Error('Invalid extraction result');
  }
  finish() {
    if (this.buffer.trim()) this.line(this.buffer);
    if (!this.result) throw new Error('Missing extraction result');
    return this.result;
  }
}
