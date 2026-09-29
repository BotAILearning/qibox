// Disposable UI preview: all accounts, conversations and model results are fixtures.
// Run with: node scripts/preview-layout-review.mjs
// The application and virtual RFB peer listen only on 127.0.0.1.
import { existsSync } from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
if (!existsSync(path.join(root, 'node_modules'))) {
  console.error('缺少 node_modules。请先为这个 checkout 安装或链接依赖，再运行预览脚本。');
  process.exit(1);
}

// Dynamic imports keep the dependency check useful even in a fresh checkout.
const [{ createApplication }, fixtures, aiFixtures, { rfbFixture }] = await Promise.all([
  import('../server/index.mjs'),
  import('../test/fixtures.mjs'),
  import('../test/ai-fixtures.mjs'),
  import('../test/rfb-fixture.mjs'),
]);
const { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } = fixtures;
const { ChatFixture, AIModelFixture, key, modelConfig } = aiFixtures;
const dataRoot = await temp();
const stopped = Promise.withResolvers();
const onStop = () => stopped.resolve();
process.once('SIGINT', onStop);
process.once('SIGTERM', onStop);
let app, peer;

try {
  const bridge = new ChatFixture();
  const today = Math.floor(Date.now() / 1000);
  bridge.contacts = [
    ['林沐 · 示例', 'person'], ['陈嘉 · 示例', 'person'], ['周可 · 示例', 'person'],
    ['许老师 · 示例', 'person'], ['产品讨论组 · 示例', 'group'], ['周末出行群 · 示例', 'group'],
  ].map(([label, kind], index) => ({ id: key(`layout-review-contact-${index}`), label, kind, lastChatAt: today - index * 3600 }));
  const conversation = [
    ['other', '周末有空吗？想一起去看看新开的展览。'],
    ['self', '周六下午有空，我们可以三点在入口见。'],
    ['other', '好呀，我会提前查好路线。'],
    ['self', '那我来预约门票，确认后告诉你。'],
    ['other', '谢谢！如果时间有变化，我们再提前联系。'],
    ['self', '好的，就先这样安排。'],
  ];
  bridge.messages = new Map(bridge.contacts.map((contact, contactIndex) => [contact.id,
    conversation.map(([direction, text], index) => ({
      id: key(`layout-review-message-${contactIndex}-${index}`), direction, text,
      timestamp: today - (6 - index) * 86400 - contactIndex * 60,
    })),
  ]));
  bridge.readDates = async ({ account, contact }) => ({
    account, contact,
    dates: [...new Set((bridge.messages.get(contact) || []).map(message =>
      new Date(message.timestamp * 1000 + 8 * 3600000).toISOString().slice(0, 10)))].sort(),
  });
  // Even if a reviewer changes a UI switch, this preview cannot send a message.
  bridge.send = async () => { throw new Error('布局预览已禁用消息发送。'); };

  const provider = new AIModelFixture();
  const fixtureComplete = provider.complete.bind(provider);
  provider.complete = async (config, system, input, signal) => {
    if (input.metrics && Array.isArray(input.messages)) {
      provider.calls.push({ system, input });
      return { report: [
        '数据开场', `本次示例记录包含 ${input.metrics.total} 条消息，围绕周末看展进行安排。双方的交流简短明确，已经确认时间，并分配了查路线和预约门票两项准备工作。`,
        '已经确认', '双方约定周六下午三点在展览入口见面。一方负责查询路线，另一方负责预约门票；预约结果仍需后续告知。',
        '沟通方式', '对话以提议、确认和分工推进。双方会回应上一条信息，没有重复确认，也没有在现有记录之外增加新的安排。',
        '待跟进事项', '下一步可以确认门票预约结果与具体入口。若行程有变化，双方约定提前联系。本页全部内容均为布局预览使用的虚构示例。',
      ].join('\n\n') };
    }
    return fixtureComplete(config, system, input, signal);
  };

  peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
  app = await createApplication({
    appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, aiProvider: provider,
    trustedHashes: [packageSha256],
    runtimeFactory: (...args) => ({
      ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in',
    }),
  });
  const space = await app.users.get('development');
  await space.setConsent(true);
  app.library.download();
  await app.library.working;
  const meta = await space.add('布局预览 · 示例微信');
  await space.start(meta.id);
  const ai = space.get(meta.id).ai;
  clearInterval(ai.timer);
  clearInterval(ai.warmupTimer);
  await ai.verifyProvider(modelConfig);
  await ai.scan();
  await ai.settings({ enabled: false, reply: true, proactive: false });
  await ai.learn({ contacts: bridge.contacts.slice(0, 3).map(contact => contact.id), target: 'both' });
  await ai.learn({ contacts: bridge.contacts.slice(0, 2).map(contact => contact.id), asDefault: true });
  await ai.learn({ contacts: [bridge.contacts[4].id], target: 'both' });
  const replyProfiles = ai.profiles().filter(profile => bridge.contacts.slice(0, 3).some(contact => contact.id === profile.contact));
  await ai.targets(replyProfiles.map(profile => profile.id), 'reply');

  for (const task of [
    { name: '周末见面提醒 · 示例', taskType: 'greeting', contacts: [bridge.contacts[0].id, bridge.contacts[1].id], goal: '确认周末见面的准备情况', requirements: '仅根据已有约定询问，不新增承诺。', schedule: { cycle: 'weekly', mode: 'fixed', time: '18:30', weekdays: [5] } },
    { name: '产品进度跟进 · 示例', taskType: 'work', contacts: [bridge.contacts[2].id], goal: '询问本周讨论事项的进展', requirements: '语气自然简短，一次只问一个问题。', schedule: { cycle: 'weekdays', mode: 'fixed', time: '10:00' } },
  ]) {
    const existing = new Set(ai.data.proactiveTasks.map(item => item.id));
    await ai.proactiveTaskAction({ command: 'create', ...task });
    const created = ai.data.proactiveTasks.find(item => !existing.has(item.id));
    await ai.proactiveTaskAction({ command: 'pause', id: created.id });
  }
  await ai.settings({ enabled: false, proactive: false });
  for (const contact of bridge.contacts.slice(0, 2)) {
    const analysis = await ai.analyze({ contacts: [contact.id], request: '总结具体约定和待跟进事项' });
    if (analysis.reports?.some(report => report.status !== 'complete')) throw new Error('示例分析报告初始化失败。');
  }
  ai.event('skip', replyProfiles[0].id, 'model-skip', '示例记录：本轮安排已经确认，无需继续回复。', { messageId: key('layout-review-skip'), reasonCode: 'model-no-reply', trigger: 'reply' });
  ai.event('error', replyProfiles[1].id, null, '示例记录：一次临时连接未完成，稍后重试即可。');
  await ai.save();
  if (bridge.sent.length) throw new Error('预览初始化期间不应发送消息。');

  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', () => { app.server.off('error', reject); resolve(); });
  });
  console.log(`PREVIEW_URL=http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`);
  console.log(`PREVIEW_INSTANCE=${meta.id}`);
  console.log(`PREVIEW_DATA_ROOT=${dataRoot}`);
  console.log('临时布局预览已就绪：6 个联系人/群、学习结果、2 个暂停任务、2 份分析报告，以及跳过/异常示例记录。');
  console.log('AI 发送和定时器已禁用。按 Ctrl+C 关闭服务并清理本次临时数据。');
  await stopped.promise;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  // cleanup() additionally verifies the qibox-test- prefix. Never remove appRoot.
  try { await app?.close(); }
  catch (error) { console.error('关闭预览应用失败：', error); process.exitCode = 1; }
  try { await peer?.close(); }
  catch (error) { console.error('关闭虚拟桌面失败：', error); process.exitCode = 1; }
  try { await cleanup(dataRoot); console.log('本次预览临时数据已清理。'); }
  catch (error) { console.error('清理预览临时数据失败：', error); process.exitCode = 1; }
  process.removeListener('SIGINT', onStop);
  process.removeListener('SIGTERM', onStop);
}
