import { randomUUID, createHash } from 'node:crypto';
import { AppError } from './files.mjs';
import { replyStrategyValue, styleValue, defaultStyle as fallbackStyle } from './ai-schema.mjs';
import { replyPresets } from './ai-presets.mjs';
import { recordSource, isDeletedActivityRecord } from './ai-activity-records.mjs';
import { personalFields, retiredPersonalFields } from './ai-personal-fields.mjs';
export { personalFields } from './ai-personal-fields.mjs';

const withoutExpiry = ({ expiresAt, ...entry }) => entry;
const timelessInformation = information => ({ ...information,
  entries: (information.entries || []).map(withoutExpiry), suggestions: information.suggestions || [],
  history: (information.history || []).map(row => ({ ...row, entries: (row.entries || []).map(withoutExpiry) })) });
export function personalInformation(a) {
  const body = a.data.personalInformation?.[a.data.account];
  return timelessInformation(body ? a.vault.open(body) : {});
}
export function selfContext(a, kind) {
  return personalInformation(a).entries.filter(entry => !retiredPersonalFields.includes(entry.field) && (kind !== 'group' || entry.allowGroup))
    .map(({ field, text, updatedAt }) => ({ field, text, source: 'user-confirmed', updatedAt }));
}
export function stageSelfSuggestions(a, suggestions, messages) {
  if (!Array.isArray(suggestions) || !a.data.account) return false;
  const information = personalInformation(a), known = new Set(information.suggestions.map(row => `${row.field}\0${row.text}`));
  const generated = new Set(a.profiles().flatMap(profile => profile.generatedIds || []));
  let changed = false;
  for (const item of suggestions.slice(0, 3)) {
    const source = messages.find(message => message.id === item?.messageId && message.direction === 'self' && !message.aiGenerated && message.authorship !== 'unknown' && !generated.has(message.id));
    if (!source || !personalFields.some(([field]) => field === item.field) || typeof item.text !== 'string' || !item.text.trim() || item.text.length > 2000) continue;
    const text = item.text.trim();
    if (known.has(`${item.field}\0${text}`) || information.entries.some(row => row.field === item.field && row.text === text)) continue;
    information.suggestions.push({ id: randomUUID(), field: item.field, text, sourceText: source.text, messageId: source.id, at: a.now() }); changed = true;
    known.add(`${item.field}\0${text}`);
  }
  if (changed) { information.suggestions = information.suggestions.slice(-30); a.data.personalInformation ||= {}; a.data.personalInformation[a.data.account] = a.vault.seal(information); }
  return changed;
}
export function styleTabs(profile = {}) {
  return [...replyPresets.filter(preset => !profile.hiddenStyleIds?.includes(`preset:${preset.id}`)).map(preset => ({
    id: `preset:${preset.id}`, label: profile.styleNames?.[`preset:${preset.id}`] || preset.label,
    style: profile.presetSnapshots?.[preset.id] || preset.style, system: true,
  })), ...(profile.customStyles || [])];
}
export function saveObjectStyle(profile, value, requested, defaultStyle) {
  const style = styleValue(value, { manual: true });
  const reference = requested === '' ? (defaultStyle || fallbackStyle) : requested === 'learned' ? profile.learnedStyle : styleTabs(profile).find(row => row.id === requested)?.style;
  // 页面展示枚举风格时会生成可读说明；原样保存说明仍然沿用原风格。
  const summary = value => value?.summary || ['formality', 'warmth', 'length', 'directness', 'emoji', 'humor', 'customTone'].map(key => value?.[key]).filter(Boolean).join('，');
  const same = reference && summary(reference) === summary(style) && ['customTone', 'customAvoid'].every(key => (reference[key] || '') === (style[key] || ''))
    && (!reference.category || !style.category || ['category', 'roles', 'avoid', 'formality', 'warmth', 'length', 'directness', 'emoji', 'humor'].every(key => JSON.stringify(reference[key]) === JSON.stringify(style[key])));
  if ((requested === '' || requested === 'learned' || requested?.startsWith('preset:')) && same) return { style: structuredClone(reference), styleId: requested };
  const custom = profile.customStyles?.find(row => row.id === requested);
  if (custom) { custom.style = style; return { style, styleId: custom.id }; }
  const id = `custom:${randomUUID()}`, label = `自定义风格 ${(profile.customStyles?.length || 0) + 1}`;
  profile.customStyles = [...(profile.customStyles || []), { id, label, style }];
  return { style, styleId: id };
}
export function migrateObjectStyles(profile) {
  profile.customStyles ||= [];
  if (profile.styleId === 'custom' && !profile.customStyles.some(row => row.id === 'custom')) profile.customStyles.push({ id: 'custom', label: '自定义风格', style: profile.style });
  if (profile.styleId === 'preset:patient') {
    const id = `custom:${randomUUID()}`;
    profile.customStyles.push({ id, label: '耐心解释', style: profile.style }); profile.styleId = id;
  } else if (profile.styleId?.startsWith('preset:')) {
    const id = profile.styleId.slice(7); profile.presetSnapshots ||= {}; profile.presetSnapshots[id] ||= profile.style;
  }
}

export async function accountConfiguration(a, value) {
  return a.exclusive(async () => {
    if (!a.data.account) throw new AppError('请先连接当前微信账号');
    const type = value?.type;
    if (['personal-information', 'personal-suggestion', 'personal-history', 'personal-restore'].includes(type) && value.account !== undefined && value.account !== a.data.account)
      throw new AppError('微信账号已变化，请重新打开我的信息', 409, 'account_changed');
    const account = a.data.account, undo = [];
    const rememberAccountValue = key => {
      const previous = a.data[key]?.[account];
      undo.push(() => { if (previous === undefined) delete a.data[key]?.[account]; else { a.data[key] ||= {}; a.data[key][account] = previous; } });
    };
    if (['personal-information', 'personal-suggestion', 'personal-restore'].includes(type)) rememberAccountValue('personalInformation');
    if (type === 'global-reply-strategy') rememberAccountValue('globalReplyStrategies');
    try {
    if (type === 'personal-information') {
      if (!Array.isArray(value.entries) || value.entries.length > 100) throw new AppError('个人信息最多保存100条');
      const previous = personalInformation(a), ids = new Set();
      const entries = value.entries.map(entry => {
        if (!(personalFields.some(([field]) => field === entry.field) || retiredPersonalFields.includes(entry.field)) || typeof entry.text !== 'string' || entry.text.length > 2000) throw new AppError('请检查个人信息内容');
        const id = entry.id || randomUUID();
        if (typeof id !== 'string' || id.length > 80 || ids.has(id)) throw new AppError('个人信息编号无效'); ids.add(id);
        return { id, field: entry.field, text: entry.text.trim(), allowGroup: entry.allowGroup === true,
          source: 'manual', updatedAt: a.now() };
      }).filter(entry => entry.text);
      // A form with only current fields cannot delete legacy hidden information
      // as a side effect of saving another field. Explicit old payloads retain
      // their previous replacement semantics, including clearing an empty value.
      for (const entry of previous.entries.filter(row => retiredPersonalFields.includes(row.field) && !value.entries.some(submitted => submitted.field === row.field))) {
        if (ids.has(entry.id)) throw new AppError('个人信息编号无效');
        ids.add(entry.id); entries.push(entry);
      }
      if (entries.length > 100) throw new AppError('个人信息最多保存100条');
      a.data.personalInformation ||= {};
      a.data.personalInformation[a.data.account] = a.vault.seal({ entries, suggestions: previous.suggestions,
        history: [...previous.history, { at: a.now(), entries: previous.entries }].slice(-20) });
      a.invalidate();
    } else if (type === 'personal-suggestion') {
      const information = personalInformation(a), candidate = information.suggestions.find(row => row.id === value.id);
      if (!candidate || !['accept', 'reject'].includes(value.command)) throw new AppError('个人信息建议已变化，请刷新');
      if (value.command === 'accept') {
        information.history = [...information.history, { at: a.now(), entries: information.entries }].slice(-20);
        information.entries = [...information.entries.filter(row => row.field !== candidate.field), { id: randomUUID(), field: candidate.field, text: candidate.text, allowGroup: false, source: 'user-confirmed', updatedAt: a.now() }];
      }
      information.suggestions = information.suggestions.filter(row => row.id !== value.id);
      a.data.personalInformation[a.data.account] = a.vault.seal(information);
      if (value.command === 'accept') a.invalidate();
    } else if (type === 'personal-history') {
      const history = personalInformation(a).history.find(row => row.at === value.at);
      if (!history) throw new AppError('历史版本不存在');
      return { history: structuredClone(history) };
    } else if (type === 'personal-restore') {
      const information = personalInformation(a), history = information.history.find(row => row.at === value.at);
      if (!history) throw new AppError('历史版本不存在');
      information.history = [...information.history, { at: a.now(), entries: information.entries }].slice(-20);
      information.entries = structuredClone(history.entries);
      a.data.personalInformation[a.data.account] = a.vault.seal(information);
      a.invalidate();
    } else if (type === 'global-reply-strategy') {
      const strategy = replyStrategyValue(value.strategy);
      a.data.globalReplyStrategies ||= {}; a.data.globalReplyStrategies[a.data.account] = strategy;
      a.invalidate();
    } else if (type === 'style') {
      const target = a.contacts.get(value.contact), id = value.id || (target && createHash('sha256').update(a.data.account + '\0' + target.id).digest('hex'));
      if (!id) throw new AppError('请选择当前账号的对象');
      const previous = a.data.profiles[id];
      const fields = ['style', 'styleId', 'customStyles', 'styleNames', 'hiddenStyleIds', 'presetSnapshots', 'learnedStyle', 'learnedAt'];
      const originals = new Map(fields.map(key => [key, structuredClone(previous?.[key])]));
      undo.push(() => {
        if (!previous) { delete a.data.profiles[id]; return; }
        for (const [key, original] of originals) { if (original === undefined) delete previous[key]; else previous[key] = original; }
      });
      if (!a.data.profiles[id] && target && value.command === 'add') a.data.profiles[id] = { id, account: a.data.account, contact: target.id, label: target.label, kind: target.kind, style: fallbackStyle, styleId: '', source: 'manual', paused: false, rounds: 0 };
      const profile = a.profile(id), current = value.styleId === 'learned' && profile.learnedStyle
        ? { id: 'learned', label: '已学习的风格' } : styleTabs(profile).find(row => row.id === value.styleId);
      if (value.command === 'add') {
        const saved = saveObjectStyle(profile, value.style || { summary: '自然回应当前话题，简短清楚，不编造事实。' }, 'new-custom', a.data.learnedDefaultStyle?.style);
        Object.assign(profile, saved);
      } else {
        if (!current || value.styleId === '' || value.styleId === 'learned' && value.command !== 'delete') throw new AppError('该风格不能修改');
        if (value.command === 'rename') {
          const name = String(value.name || '').trim();
          if (!name || name.length > 40) throw new AppError('风格名称应为1到40个字');
          if (current.system) { profile.styleNames ||= {}; profile.styleNames[current.id] = name; }
          else profile.customStyles.find(row => row.id === current.id).label = name;
        } else if (value.command === 'delete') {
          if (current.id === 'learned') { delete profile.learnedStyle; profile.learnedAt = null; }
          else if (current.system) profile.hiddenStyleIds = [...new Set([...(profile.hiddenStyleIds || []), current.id])];
          else profile.customStyles = profile.customStyles.filter(row => row.id !== current.id);
          if (profile.styleId === current.id) { profile.styleId = ''; profile.style = a.data.learnedDefaultStyle?.style || fallbackStyle; }
        } else throw new AppError('风格操作无效');
      }
      for (const [key, controller] of a.replyControllers) if (key === profile.id || key.startsWith(profile.id + ':')) controller.abort();
    } else if (type === 'clear-records' || type === 'clear-ended-tasks') {
      const taskCleanup = type === 'clear-ended-tasks', scope = value.scope || 'ended';
      if (taskCleanup && !['ended','failed','ended-failed'].includes(scope)) throw new AppError('任务清理范围无效');
      const canClearTask = task => task.account === a.data.account && !task.deletedAt && !task.deleted &&
        (scope === 'ended-failed' ? ['ended','failed'].includes(task.status) : task.status === scope);
      a.configurationConfirmations ||= new Map();
      for (const [key, confirmation] of a.configurationConfirmations) if (confirmation.expiresAt < a.now()) a.configurationConfirmations.delete(key);
      if (!value.token) {
        if (type === 'clear-records' && !['reply','skip','proactive'].includes(value.source)) throw new AppError('记录类别无效');
        const rows = taskCleanup ? (a.data.proactiveTasks || []).filter(canClearTask).map(task => task.id)
          : value.source === 'skip' ? a.skipEvents().map(row => row.id)
          : value.source === 'proactive' ? (a.data.proactiveRecords || []).filter(row => row.account === a.data.account && !isDeletedActivityRecord(a, 'proactive', row.id)).map(row => row.id)
          : a.profiles().flatMap(profile => (profile.sentMessages || []).filter(row => recordSource(row) === 'reply' && !isDeletedActivityRecord(a, 'reply', row.id)).map(row => row.id));
        const token = randomUUID(), ids = [...new Set(rows)];
        a.configurationConfirmations.set(token, { account: a.data.account, type, source: value.source, ...(taskCleanup ? {scope} : {}), ids, expiresAt: a.now() + 10 * 60000 });
        return { ...a.publicState(), confirmation: { token, count: ids.length, source: value.source } };
      }
      const confirmation = a.configurationConfirmations.get(value.token);
      if (!confirmation || confirmation.account !== a.data.account || confirmation.type !== type || confirmation.expiresAt < a.now()) throw new AppError('确认已过期，请重新操作');
      if (taskCleanup && confirmation.scope !== scope) throw new AppError('任务清理范围已变化，请重新确认');
      const ids = new Set(confirmation.ids);
      const clearedTasks = taskCleanup ? a.data.proactiveTasks.filter(task => ids.has(task.id) && canClearTask(task)) : [];
      const backups = new Map(['proactiveTasks','skipLog','events','proactiveRecords','deletedActivityRecords'].map(key => [key, a.data[key]]));
      if (taskCleanup) a.data.proactiveTasks = a.data.proactiveTasks.filter(task => !ids.has(task.id) || !canClearTask(task));
      else if (confirmation.source === 'skip') {
        a.data.skipLog = a.data.skipLog.filter(row => !ids.has(row.id)); a.data.events = a.data.events.filter(row => !ids.has(row.id));
      } else if (confirmation.source === 'proactive') a.data.proactiveRecords = a.data.proactiveRecords.filter(row => !ids.has(row.id));
      else {
        a.data.deletedActivityRecords = [...(a.data.deletedActivityRecords || []), ...confirmation.ids.map(id => ({ account: a.data.account, source: confirmation.source, id }))];
      }
      const replacements = new Map([...backups.keys()].map(key => [key, a.data[key]]));
      try { await a.save(); } catch (error) {
        for (const [key, rows] of backups) {
          if (rows === replacements.get(key)) continue;
          if (key === 'deletedActivityRecords') a.data[key] = a.data[key].filter(row => !(row.account === a.data.account && row.source === confirmation.source && ids.has(row.id)));
          else { const existing = new Set(a.data[key].map(row => row.id)); a.data[key] = [...a.data[key], ...rows.filter(row => ids.has(row.id) && !existing.has(row.id))].sort((x,y) => (y.at || 0) - (x.at || 0)); }
        }
        throw error;
      }
      a.configurationConfirmations.delete(value.token);
      return { ...a.publicState(), clearedCount: taskCleanup ? clearedTasks.length : confirmation.ids.length };
    } else throw new AppError('设置操作无效');
    await a.save(); return a.publicState();
    } catch (error) { for (const restore of undo.reverse()) restore(); throw error; }
  });
}
