// Active browser regressions for the current AI interface. The small set below
// exercises model setup, sequential one-request-per-contact analysis, report history,
// contact search, date bounds, report copy, and native file handoff.
// Retired UI snapshots stay runnable by hand; see HISTORICAL-AI-UI-TESTS.md.
import { run } from './tooling.mjs';

const output = process.argv[2] || 'reports/ai-ui-current';
for (const [script, folder] of [
  ['test-ai-takeover-ui.mjs', 'ai-assisted-wait'],
  ['test-ai-provider-ui.mjs', 'provider'],
  ['test-analysis-history-ui.mjs', 'analysis-history'],
  ['test-analysis-search-ui.mjs', 'analysis-search'],
  ['test-development050-ui.mjs', 'analysis-queue-and-files'],
]) {
  await run(process.execPath, ['scripts/' + script, `${output}/browser-${folder}`]);
}
console.log('Active AI browser regressions passed: provider setup, sequential contact queue, per-contact report history/copy, contact search, date bounds and file handoff.');
