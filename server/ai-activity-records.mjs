import { AppError } from './files.mjs';
import { readStableRange } from './ai-range.mjs';
export const recordSource = meta => ['reply', 'atMe', 'atAll', 'realtime'].includes(meta?.source) ? 'reply' : meta?.source === 'proactive' ? 'proactive' : 'unknown';
export const isDeletedActivityRecord = (a, source, id) => (a.data.deletedActivityRecords || []).some(row => row.account === a.data.account && row.source === source && row.id === id);

// New confirmed AI sends keep an encrypted copy. Older metadata is recovered
// from authenticated history by message ID, never by body text or display name.
export async function activityMessages(a, profile, source, within, signal, { hydrate = true } = {}) {
  const account = a.data.account, metadata = new Map((profile.sentMessages || []).map(m => [m.id, m]));
  const wanted = new Set([...(profile.generatedIds || []), ...metadata.keys()].filter(id => recordSource(metadata.get(id)) === source && !isDeletedActivityRecord(a, source, id) && within(metadata.get(id)?.at)));
  const found = new Map(); let failure = null, recovered = false;
  const check = () => {
    signal.throwIfAborted();
    if (account !== a.data.account) throw new AppError('微信账号已变化，请刷新', 409, 'ai_account_changed');
  };
  const add = (id, text, at) => { if (wanted.has(id) && typeof text === 'string' && text.trim() && within(at)) { const meta = metadata.get(id); found.set(id, { id, text, at, source, ...(meta?.taskId ? { taskId: meta.taskId } : {}), ...(meta?.confirmed === false ? { confirmed: false } : {}) }); } };
  for (const id of wanted) {
    const meta = metadata.get(id);
    if (meta?.body) { try { add(id, a.vault.open(meta.body).text, meta.at); } catch { failure = new AppError('部分记录正文读取失败，请重试'); } }
  }
  if (!hydrate) return { messages: [...found.values()].sort((x, y) => x.at - y.at), pending: found.size < wanted.size, unavailable: false };
  const collect = messages => {
    for (const m of messages) if (m.direction === 'self') {
      add(m.id, m.text, metadata.get(m.id)?.at || m.timestamp * 1000);
      const meta = metadata.get(m.id), value = found.get(m.id);
      // Retain only the body of an already confirmed send, encrypted exactly
      // like a new send. Future visits no longer have to reread WeChat history.
      if (meta && value && !meta.body) { meta.body = a.vault.seal({ text: value.text }); recovered = true; }
    }
  };
  try {
    if (found.size < wanted.size) {
      if (!a.contacts.has(profile.contact)) throw new AppError('联系人暂不可读取，请刷新联系人后重试');
      const missing = [...wanted].filter(id => !found.has(id)), times = missing.map(id => metadata.get(id)?.at).filter(Number.isFinite);
      if (missing.length && times.length && a.bridge.readRange) {
        try {
          const from = Math.max(0, Math.floor(Math.min(...times) / 1000) - 300), to = Math.ceil(Math.max(...times) / 1000) + 300;
          const history = await readStableRange(a.bridge, { account, contact: profile.contact, from, to, signal, skipUnparsed: true }, check);
          check(); collect(history.messages);
        } catch (error) { check(); if (error.code === 'ai_account_changed') throw error; failure = error; }
      }
      if (found.size < wanted.size) {
        try { const snapshot = await a.read(profile, signal); check(); collect(snapshot.messages); }
        catch (error) { check(); if (error.code === 'ai_account_changed') throw error; failure = error; }
      }
    }
  } catch (error) { check(); if (error.code === 'ai_account_changed') throw error; failure = error; }
  check();
  if (found.size === wanted.size) failure = null;
  return { messages: [...found.values()].sort((x, y) => x.at - y.at), unavailable: !!failure, recovered,
    ...(failure ? { error: failure instanceof AppError ? failure.message : '记录读取失败，请稍后重试' } : {}) };
}
