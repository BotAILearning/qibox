// Current production UI regression entry. The previous controller test assumed
// the retired overview controls; each suite below exercises the current UI.
import { run } from './tooling.mjs';
for (const [script, report] of [
  ['test-ai-provider-ui.mjs'],
  ['test-batch2-ui.mjs', 'reports/layout-2026-09-16/browser'],
  ['test-ai-fixes-ui.mjs', 'reports/layout-2026-09-16/browser-ai-fixes'],
  ['test-development050-ui.mjs'],
  ['test-layout060-ui.mjs'],
  ['test-development061-ui.mjs'],
  ['test-development062-ui.mjs'],
  ['test-proactive070-ui.mjs'],
  ['test-repair071-ui.mjs'],
]) await run(process.execPath, ['scripts/' + script, ...(process.argv[2] ? [process.argv[2]+'/browser-'+script.replace(/^test-|\.mjs$/g,'')] : report ? [report] : [])]);
console.log('Current AI browser regressions passed: provider, contacts, independent proactive tasks, memory, analysis and desktop recovery.');
