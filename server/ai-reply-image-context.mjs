// Only pictures already inside the account/contact-bound conversation may be
// considered. Explicit incoming/quote references win over nearby context.
export function replyImageCandidates(messages, pending, { limit = 3, recentLimit = 2, windowSize = 20, maxAgeSeconds = 1800 } = {}) {
  const rows = Array.isArray(messages) ? messages : [], current = Array.isArray(pending) ? pending : [];
  const unique = new Map();
  for (const row of rows) if (row?.id != null) unique.set(row.id, unique.has(row.id) ? null : row);
  const picked = [], ids = new Set();
  const add = row => {
    if (row?.type !== 'image' || unique.get(row.id) !== row || ids.has(row.id) || picked.length >= limit) return;
    if (row.direction !== 'other' && !(row.direction === 'self' && row.authorship === 'human' && row.aiGenerated !== true)) return;
    ids.add(row.id); picked.push(row);
  };
  for (const row of current) add(unique.get(row?.id));
  for (const row of current) if (row?.quote?.verified === true) add(unique.get(row.quote.messageId));
  // A fresh image-only turn does not by itself refer back to other pictures.
  if (!current.some(row => row?.type !== 'image' && row.unresolved !== true && typeof row.text === 'string' && row.text.trim())) return picked;
  const pendingIds = new Set(current.map(row => row?.id));
  const start = rows.findIndex(row => pendingIds.has(row?.id));
  const times = current.filter(row => Number.isSafeInteger(row?.timestamp)).map(row => row.timestamp);
  const now = times.length ? Math.max(...times) : undefined;
  if (start < 0 || !Number.isSafeInteger(now)) return picked;
  let contextCount = 0;
  for (const row of rows.slice(Math.max(0, start - windowSize), start).toReversed()) {
    if (contextCount >= recentLimit || picked.length >= limit) break;
    if (row?.type !== 'image' || !Number.isSafeInteger(row.timestamp) || row.timestamp > now || now - row.timestamp > maxAgeSeconds) continue;
    if (row.direction !== 'other' && !(row.direction === 'self' && row.authorship === 'human' && row.aiGenerated !== true)) continue;
    const before = picked.length; add(row); if (picked.length > before) contextCount++;
  }
  return picked;
}
