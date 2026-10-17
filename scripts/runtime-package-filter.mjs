import path from 'node:path';
// Preserve Node entry points, data, licenses and every runtime JS module. Only
// development material is excluded; nothing is downloaded at runtime instead.
export function runtimePackageFile(file, packageRoot, name) {
  const relative = path.relative(packageRoot, file).split(path.sep), base = relative.at(-1) || '';
  if (relative.some(part => ['test','tests','__tests__','docs','examples','.github','coverage'].includes(part))) return false;
  if (/\.(?:map|ts|tsx)$/.test(base) || /\.(?:test|spec)\.[cm]?js$/.test(base)) return false;
  if (/^(?:readme|changelog|changes|history|contributing|code_of_conduct|security)(?:\.|$)/i.test(base)) return false;
  if (name === 'pdfkit' && /^pdfkit\.(?:browser|old|standalone)/.test(base)) return false;
  if (name === 'fontkit' && /^browser(?:-module)?\.(?:cjs|mjs)$/.test(base)) return false;
  return true;
}
