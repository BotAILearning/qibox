import hashlib, json, pathlib, sys
root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / '.cache/font-tools'))
from fontTools.ttLib import TTFont
import uharfbuzz as hb

lock = json.loads((root / 'config/fonts.json').read_text(encoding='utf-8'))
report = {'status': 'passed', 'fonts': [], 'samples': []}
loaded = {}
for item in lock['fonts']:
    file = root / item['file']; data = file.read_bytes()
    assert hashlib.sha256(data).hexdigest() == item['sha256']
    font = TTFont(file); loaded[item['family']] = font.getBestCmap()
    report['fonts'].append({'family': item['family'], 'codepoints': len(font.getBestCmap()), 'sha256': item['sha256']})
    if item['family'] == 'Noto Color Emoji':
        assert 'CBDT' in font and 'CBLC' in font
        emoji_font = hb.Font(hb.Face(data)); hb.ot_font_set_funcs(emoji_font)
for sample in ['🍀', '🍃', '🌸', '✨', '🦋', '🫠', '🫩', '🐈\u200d⬛', '🧑🏽\u200d💻', '👨\u200d👩\u200d👧\u200d👦', '🇨🇳', '1\ufe0f\u20e3', '❤️']:
    buffer = hb.Buffer(); buffer.add_str(sample); buffer.guess_segment_properties(); hb.shape(emoji_font, buffer)
    ids = [info.codepoint for info in buffer.glyph_infos]
    assert ids and all(ids), (sample, ids)
    assert len(ids) == 1, (sample, ids)
    report['samples'].append({'text': sample, 'glyphs': len(ids), 'missing': False})
for sample in ['❦', '☯', '♞', '⚜', '⟡', '↠', '♈', '★', '♥']:
    families = [family for family, cmap in loaded.items() if ord(sample) in cmap]
    assert families, sample
    report['samples'].append({'text': sample, 'families': families, 'missing': False})
(root / 'reports/font-coverage.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps({'status': report['status'], 'fonts': len(report['fonts']), 'samples': len(report['samples'])}))
