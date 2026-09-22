const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');

// Keep font matching inside the bundled runtime. A directory-only fonts.conf
// misses all family aliases and can choose a Japanese face for Chinese UI.
export function fontConfiguration(root, cache, supplemental) {
  const aliases = [
    [['sans-serif', 'sans', 'system-ui', 'Arial', 'Helvetica', 'Segoe UI'], ['DejaVu Sans', 'Noto Sans CJK SC']],
    [['Microsoft YaHei', '微软雅黑', 'SimHei', '黑体', 'PingFang SC'], ['Noto Sans CJK SC', 'DejaVu Sans']],
    [['serif', 'Times New Roman', 'Times'], ['DejaVu Serif', 'Noto Serif CJK SC']],
    [['monospace', 'mono', 'Courier New', 'Courier'], ['DejaVu Sans Mono', 'Noto Sans Mono CJK SC']],
    [['emoji', 'Apple Color Emoji', 'Segoe UI Emoji'], ['Noto Color Emoji']],
    [['Segoe UI Symbol', 'Symbola'], ['Noto Sans Symbols2', 'Noto Sans Symbols', 'Noto Sans Math', 'DejaVu Sans']],
    [['math', 'Cambria Math'], ['Noto Sans Math']],
  ].flatMap(([names, families]) => names.map(name => `  <alias binding="strong"><family>${xml(name)}</family><prefer>${families.map(f => `<family>${xml(f)}</family>`).join('')}</prefer></alias>`)).join('\n');
  return `<?xml version="1.0"?>
<!DOCTYPE fontconfig SYSTEM "urn:fontconfig:fonts.dtd">
<fontconfig>
  <dir>${xml(root)}/usr/share/fonts</dir>
${supplemental ? `  <dir>${xml(supplemental)}</dir>` : ''}
  <cachedir>${xml(cache)}</cachedir>
${aliases}
  <match target="pattern">
    <test name="lang" compare="contains"><string>zh</string></test>
    <edit name="family" mode="append" binding="strong"><string>Noto Sans CJK SC</string></edit>
  </match>
  <match target="pattern">
    <edit name="family" mode="append" binding="weak"><string>Noto Color Emoji</string><string>Noto Sans Symbols2</string><string>Noto Sans Symbols</string><string>Noto Sans Math</string></edit>
  </match>
  <!-- Exclude legacy X11 bitmaps, but keep modern color emoji bitmap fonts. -->
  <selectfont><rejectfont><glob>*.pcf</glob><glob>*.pcf.gz</glob><glob>*.bdf</glob></rejectfont></selectfont>
  <match target="font">
    <edit name="antialias" mode="assign"><bool>true</bool></edit>
    <edit name="hinting" mode="assign"><bool>true</bool></edit>
    <edit name="hintstyle" mode="assign"><const>hintslight</const></edit>
    <edit name="rgba" mode="assign"><const>none</const></edit>
    <edit name="embeddedbitmap" mode="assign"><bool>false</bool></edit>
  </match>
  <match target="font">
    <test name="color"><bool>true</bool></test>
    <edit name="embeddedbitmap" mode="assign"><bool>true</bool></edit>
  </match>
  <include>${xml(root)}/usr/share/fontconfig/conf.avail/10-scale-bitmap-fonts.conf</include>
</fontconfig>
`;
}
