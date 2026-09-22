"""Render synthetic nicknames with the NAS's actual Pango/FreeType/fontconfig."""
import ctypes as c, json, os, pathlib, subprocess, sys
base = pathlib.Path(sys.argv[1]); runtime = pathlib.Path(sys.argv[2])
matches = {}
for name, pattern in {'chinese': 'Microsoft YaHei:lang=zh-cn:charset=6bd2', 'emoji': 'sans-serif:charset=1f340', 'decoration': 'sans-serif:charset=2766', 'math': 'sans-serif:charset=27e1', 'ascii': 'sans-serif:charset=41'}.items():
    matches[name] = subprocess.check_output([str(runtime / 'usr/bin/fc-match'), '-f', '%{family}|%{file}|%{color}|%{embeddedbitmap}', pattern], text=True).strip()
assert 'Noto Sans CJK SC' in matches['chinese'], matches
assert 'Noto Color Emoji' in matches['emoji'], matches
assert 'Noto Sans Math' in matches['math'], matches
assert 'Noto Color Emoji' not in matches['ascii'], matches

cairo = c.CDLL('libcairo.so.2'); pango = c.CDLL('libpango-1.0.so.0'); pc = c.CDLL('libpangocairo-1.0.so.0'); obj = c.CDLL('libgobject-2.0.so.0')
def bind(lib, name, result, *args):
    fn = getattr(lib, name); fn.restype = result; fn.argtypes = args; return fn
ptr, dbl, integer, text = c.c_void_p, c.c_double, c.c_int, c.c_char_p
surface = bind(cairo, 'cairo_image_surface_create', ptr, integer, integer, integer)(0, 1120, 540)
context = bind(cairo, 'cairo_create', ptr, ptr)(surface)
rgb = bind(cairo, 'cairo_set_source_rgb', None, ptr, dbl, dbl, dbl)
rgb(context, 0.96, 0.98, 0.97); bind(cairo, 'cairo_paint', None, ptr)(context)
layout = bind(pc, 'pango_cairo_create_layout', ptr, ptr)(context)
font = bind(pango, 'pango_font_description_from_string', ptr, text)(b'Noto Sans CJK SC 28')
bind(pango, 'pango_layout_set_font_description', None, ptr, ptr)(layout, font)
set_text = bind(pango, 'pango_layout_set_text', None, ptr, text, integer)
unknown = bind(pango, 'pango_layout_get_unknown_glyphs_count', integer, ptr)
measure = bind(pango, 'pango_layout_get_pixel_size', None, ptr, c.POINTER(integer), c.POINTER(integer))
move = bind(cairo, 'cairo_move_to', None, ptr, dbl, dbl)
show = bind(pc, 'pango_cairo_show_layout', None, ptr, ptr)
rows = ['昵称示例：毒药🍀  清风🍃  花开🌸', '彩色表情：🦋 ✨ 🫠 🫩 ❤️', '组合表情：🐈\u200d⬛  🧑🏽\u200d💻  👨\u200d👩\u200d👧\u200d👦', '旗帜与键帽：🇨🇳  1\ufe0f\u20e3', '装饰符号：❦ ☯ ♞ ⚜ ⟡ ↠ ♈ ★ ♥', '普通文字：栖盒  Hello  12345']
results = []
for i, row in enumerate(rows):
    set_text(layout, row.encode(), -1); count = unknown(layout)
    assert count == 0, (row, count)
    width, height = integer(), integer(); measure(layout, c.byref(width), c.byref(height))
    assert width.value <= 1056 and height.value <= 70, (row, width.value, height.value)
    results.append({'text': row, 'missingGlyphs': count, 'width': width.value, 'height': height.value})
    rgb(context, 0.13, 0.24, 0.19); move(context, 32, 20 + i * 84); show(context, layout)
output = base / 'font-render.png'
assert bind(cairo, 'cairo_surface_write_to_png', integer, ptr, text)(surface, str(output).encode()) == 0
bind(pango, 'pango_font_description_free', None, ptr)(font); bind(obj, 'g_object_unref', None, ptr)(layout)
bind(cairo, 'cairo_destroy', None, ptr)(context); bind(cairo, 'cairo_surface_destroy', None, ptr)(surface)
report = {'status': 'passed', 'renderer': 'native Linux Pango/Cairo with packaged fontconfig and runtime libraries', 'actualWechatNicknameVerified': False, 'matches': matches, 'rows': results}
(base / 'font-native.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(report, ensure_ascii=False))
