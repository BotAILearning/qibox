import { randomUUID } from 'node:crypto';
import { AppError } from './files.mjs';

export const MESSAGE_LEDGER_LIMITS = Object.freeze({ scopes: 200, messages: 300, textBytes: 4 * 1024 * 1024, messageCharacters: 20000, scopeBytes: 4096 });

const directions = new Set(['self', 'other', 'system']);
const sameMessage = (left, right) => left.direction === right.direction && left.text === right.text;
function matchesAt(haystack, needle, start, length = needle.length) {
  if (start + length > haystack.length) return false;
  for (let i = 0; i < length; i++) if (!sameMessage(haystack[start + i], needle[i])) return false;
  return true;
}
function invalid() { throw new AppError('暂时无法读取完整消息，请重新检测', 409, 'ai_ledger_invalid'); }
function changed() { throw new AppError('聊天内容已变化，请重新检测', 409, 'ai_ledger_ambiguous'); }
function full() { throw new AppError('聊天范围过大，请重新检测', 409, 'ai_ledger_limit'); }
function validateScope(scope) {
  if (typeof scope !== 'string' || !scope || Buffer.byteLength(scope) > MESSAGE_LEDGER_LIMITS.scopeBytes) invalid();
}

// These IDs identify observations only within this in-memory ledger. They are
// deliberately random, not content hashes or permanent native message IDs.
// Never evict a live scope silently: losing its cursor could replay old messages.
export class MessageLedger {
  #scopes = new Map();
  #textBytes = 0;

  reconcile(scope, messages) {
    validateScope(scope);
    if (!Array.isArray(messages)) invalid();
    if (messages.length > MESSAGE_LEDGER_LIMITS.messages) full();
    let textBytes = 0;
    const incoming = messages.map(message => {
      if (!message || !directions.has(message.direction) || typeof message.text !== 'string') invalid();
      if (message.text.length > MESSAGE_LEDGER_LIMITS.messageCharacters) full();
      textBytes += Buffer.byteLength(message.text);
      return { direction: message.direction, text: message.text };
    });
    const previous = this.#scopes.get(scope);
    if (!previous && this.#scopes.size >= MESSAGE_LEDGER_LIMITS.scopes) full();
    const nextTextBytes = this.#textBytes - (previous?.textBytes ?? 0) + textBytes;
    if (nextTextBytes > MESSAGE_LEDGER_LIMITS.textBytes) full();

    const old = previous?.messages ?? [];
    let overlap = 0;
    if (old.length === incoming.length && matchesAt(old, incoming, 0)) {
      return old.map(message => ({ ...message }));
    }
    if (old.length) {
      if (!incoming.length) changed();
      // A subset of the old window is history/truncation, not a new tail.
      for (let start = 0; start + incoming.length <= old.length; start++) {
        if (matchesAt(old, incoming, start)) changed();
      }
      // Loading earlier messages is also unsafe, including repeated windows
      // that could otherwise look like an append at the original position.
      for (let start = 1; start + old.length <= incoming.length; start++) {
        if (matchesAt(incoming, old, start)) changed();
      }
      let alignments = 0;
      for (let length = 1; length <= Math.min(old.length, incoming.length); length++) {
        if (matchesAt(old, incoming, old.length - length, length)) {
          overlap = length;
          alignments++;
        }
      }
      // Count even alignments with no appended messages: a shorter repeated
      // match must not turn a deleted tail into apparently new messages.
      if (alignments !== 1 || overlap >= incoming.length) changed();
    }

    const next = incoming.map((message, index) => ({
      ...message,
      id: index < overlap ? old[old.length - overlap + index].id : `temporary:${randomUUID()}`,
    }));
    // Validation and alignment must finish before any state changes.
    this.#scopes.set(scope, { messages: next, textBytes });
    this.#textBytes = nextTextBytes;
    return next.map(message => ({ ...message }));
  }

  clear(scope) {
    if (scope === undefined) {
      this.#scopes.clear();
      this.#textBytes = 0;
      return;
    }
    validateScope(scope);
    const previous = this.#scopes.get(scope);
    if (previous) {
      this.#textBytes -= previous.textBytes;
      this.#scopes.delete(scope);
    }
  }
}
