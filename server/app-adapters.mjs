import path from 'node:path';
import { AppError } from './files.mjs';

// App definitions are the boundary between the shared lifecycle and optional
// desktop/WeChat/container capabilities. Existing appId/data paths are retained.
export const inertAI = () => ({ async suspend() {}, async close() {}, async manualInput() {} });
export const manualSchedule = () => ({ begin() {}, async init() {}, async pause() {}, async close() {}, async interact() {}, async tick() {},
  async save(value) { if (value.mode !== 'manual') throw new AppError('此应用采用手动启动'); },
  publicState() { return { mode: 'manual', paused: false }; } });
export function bundledLibrary(definition) {
  return { installed: () => ({ version: '1', directory: '', executable: definition.executable }),
    publicState: () => ({ installed: { version: '内置适配' }, architecture: definition.architecture, job: null }) };
}
export async function createAdapterRuntime(definition, options) {
  if (definition.adapter === 'docker') {
    const { DockerRuntime } = await import('./docker-runtime.mjs'); return new DockerRuntime({ ...options, definition });
  }
  const { Runtime } = await import('./runtime.mjs');
  return new Runtime({ ...options, definition, application: definition.id === 'wechat' ? options.application : () => ({ version: '1', directory: options.runtimeRoot, executable: path.join(options.runtimeRoot, definition.executable) }) });
}
