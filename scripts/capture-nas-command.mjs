import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const [outputPath, ...commandParts] = process.argv.slice(2);
if (!outputPath || !commandParts.length) throw new Error('usage: node scripts/capture-nas-command.mjs OUTPUT COMMAND...');
const python = 'C:/Users/HW/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe';
const runner = 'reports/analysis-report-20260922/nas.py';
const command = commandParts.join(' ');
const result = spawnSync(python, [runner, '--command', command], { encoding: 'utf8', windowsHide: true });
await writeFile(outputPath, JSON.stringify({ command, status: result.status, signal: result.signal, stdout: result.stdout || '', stderr: result.stderr || '' }, null, 2));
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
