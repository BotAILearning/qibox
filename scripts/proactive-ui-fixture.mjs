// Disposable application for the proactive-chat browser checks. All contacts,
// model responses and deliveries are fixtures; no NAS or model service is used.
import path from 'node:path';
import { createApplication } from '../server/index.mjs';
import { root } from './tooling.mjs';
import { temp, cleanup, runtimeFactory, extractor, fetcher, packageSha256 } from '../test/fixtures.mjs';
import { ChatFixture, AIModelFixture, modelConfig } from '../test/ai-fixtures.mjs';
import { rfbFixture } from '../test/rfb-fixture.mjs';

export async function proactiveFixture() {
  const dataRoot = await temp(), bridge = new ChatFixture(), provider = new AIModelFixture();
  ['陈小雨', '林一', '周末'].forEach((label, i) => { bridge.contacts[i].label = label; });
  const opened = [];
  bridge.openChat = async ({ contact }) => { opened.push(contact); return { opened: true }; };
  const original = provider.complete.bind(provider);
  provider.complete = async (config, system, input, signal) => input.mode === 'proactive'
    ? { action: 'send', text: `关于${input.strategy.purpose}，你方便聊聊吗？` }
    : original(config, system, input, signal);
  const peer = await rfbFixture(path.join(root, 'web/backgrounds/mist.jpg'));
  const app = await createApplication({ appRoot: root, dataRoot, dev: true, extract: extractor, fetcher, trustedHashes: [packageSha256], aiProvider: provider,
    runtimeFactory: (...args) => ({ ...runtimeFactory(...args), port: peer.port, aiBridge: bridge, loginStatus: 'logged-in' }) });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const space = await app.users.get('development'); await space.setConsent(true);
  app.library.download(); await app.library.working;
  const instance = await space.add('主动聊天本地验收'); await space.start(instance.id);
  const ai = space.get(instance.id).ai;
  clearInterval(ai.timer); await ai.verifyProvider(modelConfig); await ai.scan();
  await ai.settings({ enabled: false, reply: false });
  ai.interval = () => 0;
  return { app, ai, bridge, provider, instance, opened, dataRoot,
    url: `http://127.0.0.1:${app.server.address().port}${app.prefix}/?dev=${app.devKey}`,
    async close() { await app.close(); await peer.close(); await cleanup(dataRoot); }
  };
}

if (process.argv.includes('--serve')) {
  const fixture = await proactiveFixture();
  console.log(fixture.url);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; await fixture.close(); process.exit(0); };
  process.on('SIGINT', close); process.on('SIGTERM', close);
}
