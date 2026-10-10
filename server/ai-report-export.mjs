import path from 'node:path';
import { fileURLToPath } from 'node:url';
import PDFDocument from 'pdfkit';
import { openSync } from 'fontkit';
import { zipSync, strToU8 } from 'fflate';
import { AppError } from './files.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fontPath = path.join(root, 'fonts/NotoSansCJKsc-Regular.otf');
const pdfFontPaths = [fontPath, ...['NotoEmoji-Regular.ttf', 'NotoSansSymbols-Regular.ttf', 'NotoSansSymbols2-Regular.ttf', 'NotoSansMath-Regular.ttf'].map(name => path.join(root, 'fonts', name))];
const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
let pdfFonts;

function textRuns(text, selections) {
  pdfFonts ||= pdfFontPaths.map(file => ({ file, font: openSync(file) }));
  const runs = [];
  for (const { segment } of graphemes.segment(text)) {
    let selected = selections.get(segment);
    if (!selected) {
      const emoji = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(segment);
      const candidates = emoji ? [pdfFonts[1], ...pdfFonts.filter((_, i) => i !== 1)] : pdfFonts;
      selected = /^\s+$/u.test(segment) ? pdfFonts[0] : candidates.find(({ font }) => font.layout(segment).glyphs.every(glyph => glyph.id !== 0));
      if (selected) selections.set(segment, selected);
    }
    if (!selected) throw new AppError('报告包含当前 PDF 字库不支持的字符，请使用 Word 格式导出', 422);
    const previous = runs.at(-1);
    if (previous?.file === selected.file) previous.text += segment;
    else runs.push({ file: selected.file, text: segment });
  }
  return runs;
}
const clean = value => String(value ?? '').toWellFormed().replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]/g, '');
const xml = value => clean(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const date = value => Number.isFinite(value) ? new Date(value + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') : '未知时间';
const stamp = value => date(value).replace(/[-: ]/g, '');
const range = value => value?.from && value?.to ? `${value.from} 至 ${value.to}` : '全部';
const safeName = value => Array.from(clean(value).toWellFormed().replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')).slice(0, 48).join('').replace(/[. ]+$/g, '') || '联系人';

function linesFor(report) {
  const lines = [
    { text: '分析报告', kind: 'title' },
    { text: `联系人：${report.label || '联系人'}`, kind: 'meta' },
    { text: `生成时间：${date(report.createdAt)}`, kind: 'meta' },
    { text: `选择范围：${range(report.requestedRange)}`, kind: 'meta' },
    { text: `实际分析范围：${range(report.actualRange)}`, kind: 'meta' },
  ];
  const metrics = report.metrics || {};
  const values = [['total', '消息'], ['self', '你发送'], ['other', '对方发送'], ['activeDays', '活跃天数']]
    .filter(([key]) => Number.isFinite(metrics[key])).map(([key, label]) => `${label} ${metrics[key]}`);
  if (values.length) lines.push({ text: values.join('  ·  '), kind: 'stats' });
  const analyzed = Number.isInteger(report.analyzedCount) ? report.analyzedCount : report.count;
  if (Number.isInteger(analyzed)) lines.push({ text: report.mediaCoverage ? `本次使用 ${analyzed} 条记录，内容已解析 ${report.contentParsedCount ?? 0} 条` : `实际分析 ${analyzed} 条聊天记录${Number.isInteger(report.analyzedChars) ? `、${report.analyzedChars} 字` : ''}`, kind: 'note' });
  if (Number.isInteger(report.skipped) && report.skipped > 0) lines.push({ text: `已跳过 ${report.skipped} 条无法解析的记录。`, kind: 'note' });
  for (const [type, name] of [['voice', '语音'], ['image', '图片'], ['video', '视频']]) {
    const item = report.mediaCoverage?.[type];
    if (item?.selected && item.total) {
      const unit = type === 'image' ? '张' : type === 'video' ? '段' : '条';
      const skipped = (item.skipped || 0) + (item.limited || 0);
      lines.push({ text: `${name}：已分析 ${item.analyzed} ${unit}${skipped ? `，跳过 ${skipped} ${unit}` : ''}。`, kind: 'note' });
    }
  }
  const reasons = new Set(report.truncatedReasons || []);
  if (reasons.has('message_limit')) lines.push({ text: '部分较早的聊天未读取，统计仅包含已读取的记录。', kind: 'warning' });
  if (reasons.has('analysis_sample')) lines.push({ text: `本次分析 ${report.sampledCount ?? 0} 条已读取的聊天记录。`, kind: 'warning' });
  if (reasons.has('character_limit')) lines.push({ text: '聊天内容较多，本次只分析了较近的内容。', kind: 'warning' });
  if (reasons.has('source_read_truncated')) lines.push({ text: '部分聊天未能读取，报告仅依据已读取的记录。', kind: 'warning' });
  if (reasons.has('message_length')) lines.push({ text: '部分较长消息未完整纳入报告。', kind: 'warning' });
  if (reasons.has('message_output_limit')) lines.push({ text: '部分聊天未纳入报告。', kind: 'warning' });
  if (report.truncated && !reasons.size) lines.push({ text: '部分记录未完整纳入，统计仅覆盖已读取的可读记录。', kind: 'warning' });
  if (clean(report.request).trim()) lines.push({ text: '分析要求', kind: 'heading' }, { text: clean(report.request), kind: 'body' });
  lines.push({ text: '报告正文', kind: 'heading' });
  for (const part of clean(report.report).replace(/\r\n?/g, '\n').split('\n')) lines.push({ text: part, kind: part ? 'body' : 'space' });
  return lines;
}

function docxParagraph({ text, kind }) {
  const style = kind === 'title' ? 'Title' : kind === 'heading' ? 'Heading1' : kind === 'warning' ? 'Warning' : 'Normal';
  const spacing = kind === 'space' ? '<w:spacing w:after="100"/>' : '';
  return `<w:p><w:pPr><w:pStyle w:val="${style}"/>${spacing}</w:pPr><w:r><w:t xml:space="preserve">${xml(text)}</w:t></w:r></w:p>`;
}

export function makeDocx(report) {
  const body = linesFor(report).map(docxParagraph).join('');
  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1000" w:right="1000" w:bottom="1000" w:left="1000"/></w:sectPr></w:body></w:document>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Noto Sans SC" w:eastAsia="Noto Sans SC"/></w:rPr></w:rPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:rPr><w:sz w:val="22"/></w:rPr><w:pPr><w:spacing w:after="120" w:line="330" w:lineRule="auto"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:rPr><w:b/><w:sz w:val="40"/><w:color w:val="252940"/></w:rPr><w:pPr><w:spacing w:after="280"/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:rPr><w:b/><w:sz w:val="27"/><w:color w:val="394FBF"/></w:rPr><w:pPr><w:spacing w:before="300" w:after="140"/><w:keepNext/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Warning"><w:name w:val="Warning"/><w:rPr><w:color w:val="9B5A14"/></w:rPr></w:style></w:styles>`;
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>'),
    'word/_rels/document.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'),
    'word/document.xml': strToU8(document), 'word/styles.xml': strToU8(styles),
  }, { level: 6 }));
}

export async function makePdf(report) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48, bufferPages: true, info: { Title: '分析报告', Author: '栖盒' } });
    const chunks = [];
    doc.on('data', chunk => chunks.push(chunk));
    doc.once('error', reject);
    doc.once('end', () => resolve(Buffer.concat(chunks)));
    try {
      const selections = new Map();
      doc.font(fontPath);
      for (const line of linesFor(report)) {
        if (line.kind === 'space') { doc.moveDown(.45); continue; }
        if (line.kind === 'heading') doc.moveDown(.55);
        const size = line.kind === 'title' ? 21 : line.kind === 'heading' ? 14 : line.kind === 'meta' || line.kind === 'note' ? 10 : 11;
        const color = line.kind === 'title' ? '#252940' : line.kind === 'heading' ? '#394fbf' : line.kind === 'warning' ? '#9b5a14' : '#41465e';
        const runs = textRuns(line.text || ' ', selections);
        for (const [index, run] of runs.entries()) {
          doc.font(run.file).fontSize(size).fillColor(color).text(run.text, {
            continued: index < runs.length - 1,
            lineGap: 3, paragraphGap: line.kind === 'title' ? 11 : line.kind === 'heading' ? 5 : 2,
          });
        }
      }
      const { start, count } = doc.bufferedPageRange();
      for (let index = start; index < start + count; index++) {
        doc.switchToPage(index);
        doc.font(fontPath).fontSize(9).fillColor('#8990a2').text(`${index + 1} / ${count}`, 500, 804, { lineBreak: false });
      }
      doc.end();
    } catch (error) { doc.destroy(); reject(error); }
  });
}

export async function exportAnalysisReports(ai, { ids, format }, { signal } = {}) {
  if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new AppError('请选择有效的分析报告');
  if (!['pdf', 'docx'].includes(format)) throw new AppError('请选择 Word 或 PDF 格式');
  const account = ai.data.account;
  if (!account) throw new AppError('请先确认当前微信账号', 409);
  const reports = ids.map(id => ai.analysisReport(id));
  const files = {}, ext = format === 'pdf' ? 'pdf' : 'docx';
  let totalBytes = 0;
  for (const report of reports) {
    if (signal?.aborted) throw new AppError('导出已取消', 499);
    const bytes = format === 'pdf' ? await makePdf(report) : makeDocx(report);
    totalBytes += bytes.length;
    if (totalBytes > 64 * 1024 * 1024) throw new AppError('文件总量超过当前安全容量，请分批导出', 413);
    const baseName = `分析报告_${safeName(report.label)}_${stamp(report.createdAt)}_${report.id.slice(-8)}`;
    let filename = `${baseName}.${ext}`, suffix = 2;
    while (Object.hasOwn(files, filename)) filename = `${baseName}_${suffix++}.${ext}`;
    files[filename] = new Uint8Array(bytes);
  }
  if (signal?.aborted) throw new AppError('导出已取消', 499);
  if (ai.data.account !== account) throw new AppError('微信账号已变化，请重新选择报告', 409);
  if (reports.length === 1) return { filename: Object.keys(files)[0], bytes: Buffer.from(Object.values(files)[0]), mime: format === 'pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
  const bytes = Buffer.from(zipSync(files, { level: 6 }));
  return { filename: `分析报告_批量_${stamp(Date.now())}_${reports.length}份.zip`, bytes, mime: 'application/zip' };
}
