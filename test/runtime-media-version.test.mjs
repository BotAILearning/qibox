import test from 'node:test';
import assert from 'node:assert/strict';
import { validateMediaVersions } from '../server/runtime-resources.mjs';

const libraries = ['libavutil', 'libavcodec', 'libavformat', 'libavdevice', 'libavfilter', 'libswscale', 'libswresample', 'libpostproc'];
const output = tool => `${tool} version 5.1.7-0+deb12u1\n` + libraries.map((name, index) => `${name} ${57 + index}. 28.100 / ${57 + index}. 28.100`).join('\n');

test('media selftest accepts matching compiled and loaded tool/library versions', () => {
  assert.equal(validateMediaVersions(output('ffmpeg'), output('ffprobe')).libavutil, '57.28.100');
});
test('media selftest rejects a same-soname library with different runtime version', () => {
  assert.throws(() => validateMediaVersions(output('ffmpeg').replace('/ 57. 28.100', '/ 58. 28.100'), output('ffprobe')), /编译与运行版本不一致/);
});
test('media selftest rejects different tool releases and incomplete reports', () => {
  assert.throws(() => validateMediaVersions(output('ffmpeg'), output('ffprobe').replace('5.1.7', '5.1.8')), /组件版本不一致/);
  assert.throws(() => validateMediaVersions(output('ffmpeg'), output('ffprobe').replace('libpostproc', 'missing')), /编译与运行版本不一致/);
});
