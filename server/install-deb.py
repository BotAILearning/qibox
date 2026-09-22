"""Extract official WeChat application files without running package scripts.

The destination must be a fresh private directory. No host packages are installed.
Archive links and file types are validated before any extraction is performed.
"""
import io, json, os, pathlib, re, sys, tarfile, time

LIMIT = 3 * 1024 ** 3

def deb_members(package):
    entries = {}
    length = package.stat().st_size
    if length > 1024 ** 3: raise ValueError('安装包过大')
    with package.open('rb') as reader:
        if reader.read(8) != b'!<arch>\n': raise ValueError('请选择微信 deb 安装包')
        while reader.tell() < length:
            header = reader.read(60)
            if len(header) != 60 or header[58:] != b'`\n': raise ValueError('安装包不完整')
            name = header[:16].decode('ascii').strip().rstrip('/')
            size = int(header[48:58].strip())
            offset = reader.tell()
            if size < 0 or offset + size > length or name in entries: raise ValueError('安装包结构无效')
            entries[name] = (offset, size)
            if len(entries) > 16: raise ValueError('安装包结构无效')
            reader.seek(size + size % 2, 1)
    return entries

def inspect_deb(package):
    entries = deb_members(package)
    control = next((name for name in ['control.tar.xz', 'control.tar.gz', 'control.tar'] if name in entries), None)
    data = next((name for name in ['data.tar.xz', 'data.tar.gz', 'data.tar'] if name in entries), None)
    if not control or not data or 'debian-binary' not in entries: raise ValueError('安装包格式暂不支持，请重新获取官方 deb 安装包')
    with package.open('rb') as reader:
        reader.seek(entries['debian-binary'][0])
        if entries['debian-binary'][1] != 4 or reader.read(4) != b'2.0\n': raise ValueError('安装包结构无效')
        offset, size = entries[control]
        if size > 1024 ** 2: raise ValueError('安装包元信息过大')
        reader.seek(offset); compressed = reader.read(size)
    fields, size, count = {}, 0, 0
    with tarfile.open(fileobj=io.BytesIO(compressed), mode='r:*') as archive:
        for member in archive:
            size += member.size; count += 1
            if size > 1024 ** 2 or count > 1000: raise ValueError('安装包元信息过大')
            if member.name.removeprefix('./') == 'control':
                if not member.isfile() or member.size > 128 * 1024: raise ValueError('安装包元信息无效')
                text = archive.extractfile(member).read().decode('utf-8')
                fields = dict(line.split(':', 1) for line in text.splitlines() if ':' in line and not line.startswith((' ', '\t')))
                break
    return {k: v.strip() for k, v in fields.items()}, data, entries[data]

def inspect_and_extract(package, destination, progress=None, architecture='amd64'):
    if architecture not in ('amd64', 'arm64'):
        raise ValueError('设备架构暂不支持')
    label = 'ARM64' if architecture == 'arm64' else 'x86_64'
    target = pathlib.Path(destination).resolve()
    if not target.is_dir() or any(target.iterdir()):
        raise ValueError('安装目录无效')
    fields, data_name, (offset, length) = inspect_deb(package)
    if fields.get('Package') != 'wechat' or fields.get('Architecture') != architecture:
        raise ValueError(f'请选择 {label} 版微信 deb 安装包')
    if not re.fullmatch(r'\d+(?:\.\d+){1,5}', fields.get('Version', '')):
        raise ValueError('无法识别微信版本，请从官网下载')
    archive = target / data_name
    with package.open('rb') as reader, archive.open('xb') as writer:
        reader.seek(offset)
        while length:
            data = reader.read(min(length, 1024 * 1024))
            if not data: raise ValueError('安装包不完整')
            writer.write(data); length -= len(data)
    with tarfile.open(archive, 'r:*') as source:
        members, total = [], 0
        for member in source:
            members.append(member); total += member.size
            if len(members) > 50000 or total > LIMIT: raise ValueError('安装包解压后过大')
        extract(source, members, target, progress)
    archive.unlink()
    binary = target / 'opt/wechat/wechat'
    if not binary.is_file():
        binary = target / 'opt/wechat/WeChat'
    if not binary.is_file() or binary.is_symlink(): raise ValueError('安装包中未找到微信程序')
    with binary.open('rb') as stream:
        elf = stream.read(20)
    machine = b'\xb7\x00' if architecture == 'arm64' else b'\x3e\x00'
    if elf[:6] != b'\x7fELF\x02\x01' or elf[18:20] != machine:
        raise ValueError(f'请选择 {label} 版微信安装包')
    return {'version': fields['Version'], 'arch': architecture, 'binary': str(binary.relative_to(target))}

def extract(source, members, target, progress=None):
    selected, names, links = [], set(), set()
    size = 0
    for member in members:
        name = member.name.removeprefix('./').rstrip('/')
        parts = pathlib.PurePosixPath(name).parts
        if member.name.startswith('/') or '..' in parts or '\\' in name or '\x00' in name:
            raise ValueError('安装包包含无效路径')
        if not (name == 'opt/wechat' or name.startswith('opt/wechat/')): continue
        if name in names: raise ValueError('安装包包含重复文件')
        names.add(name)
        if not (member.isdir() or member.isfile() or member.issym()): raise ValueError('安装包包含不支持的文件')
        if member.issym():
            if os.path.isabs(member.linkname) or '\\' in member.linkname: raise ValueError('安装包包含无效链接')
            resolved = (target / name).parent.joinpath(member.linkname).resolve()
            if not resolved.is_relative_to(target / 'opt/wechat'): raise ValueError('安装包包含无效链接')
            links.add(name)
        size += member.size
        if size > LIMIT: raise ValueError('安装包解压后过大')
        selected.append((name, member))
    # No entry can traverse an archive-created symlink, regardless of order.
    for name, member in selected:
        if any(str(parent) in links for parent in pathlib.PurePosixPath(name).parents):
            raise ValueError('安装包包含无效链接路径')
    total = sum(member.size for _, member in selected if member.isfile())
    written = 0
    if progress: progress(written, total)
    for name, member in selected:
        output = target / name
        output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        if member.isdir(): output.mkdir(exist_ok=True, mode=0o700)
        elif member.issym(): output.symlink_to(member.linkname)
        else:
            with source.extractfile(member) as reader, output.open('xb') as writer:
                remaining = member.size
                while remaining:
                    chunk = reader.read(min(remaining, 1024 * 1024))
                    if not chunk: raise ValueError('安装包不完整')
                    writer.write(chunk); remaining -= len(chunk); written += len(chunk)
                    if progress: progress(written, total)
            output.chmod(0o700 if member.mode & 0o111 else 0o600)

if __name__ == '__main__':
    try:
        last_progress = [None]
        def progress(written, total):
            now = time.monotonic()
            if last_progress[0] is None or now - last_progress[0] >= 0.2 or written == total:
                print(json.dumps({'type': 'progress', 'stage': 'extracting', 'bytes': written, 'total': total}), flush=True)
                last_progress[0] = now
        result = inspect_and_extract(pathlib.Path(sys.argv[1]), sys.argv[2], progress, sys.argv[3] if len(sys.argv) > 3 else 'amd64')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
