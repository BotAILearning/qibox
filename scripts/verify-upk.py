"""Read-only verification of official ugcli output; never alters its signatures."""
import hashlib, io, json, pathlib, re, sys, tarfile, zipfile

root = pathlib.Path(__file__).resolve().parents[1]
product = json.loads((root / 'config/product.json').read_text(encoding='utf-8'))

def package_members(file):
    with file.open('rb') as stream:
        if stream.read(17) == b'UGREEN-PKG-FORMAT':
            fields = {}; size = file.stat().st_size
            while stream.tell() < size:
                offset = stream.tell(); header = stream.read(64)
                match = re.match(rb'([a-z]+):(\d+):', header)
                assert match, offset
                length = int(match[2]); start = offset + len(match[0]); name = match[1].decode()
                assert name not in fields and start + length <= size
                stream.seek(start); fields[name] = stream.read(length)
            assert set(fields) == {'sig', 'pub', 'ico', 'ugb', 'obj'}
            assert len(fields['sig']) == 256 and fields['ico'].startswith(b'\x89PNG')
            assert fields['ico'] == (root / 'build/qibox-ugos/rootfs_common/icon.png').read_bytes(), 'Outer UPK icon is stale'
            # Preserve the vendor signature wrapper exactly; device authorization
            # remains a separate NAS acceptance step. Only inspect its payload.
            with tarfile.open(fileobj=io.BytesIO(fields['ugb']), mode='r:*') as archive:
                return {member.name.removeprefix('./'): archive.extractfile(member).read() for member in archive if member.isfile()}
    if zipfile.is_zipfile(file):
        with zipfile.ZipFile(file) as archive:
            assert archive.testzip() is None
            return {name: archive.read(name) for name in archive.namelist() if not name.endswith('/')}
    with tarfile.open(file, 'r:*') as archive:
        return {member.name.removeprefix('./'): archive.extractfile(member).read() for member in archive if member.isfile()}

def inspect_ugb(data):
    hashes, modes, values = {}, {}, {}
    with tarfile.open(fileobj=io.BytesIO(data), mode='r|*') as archive:
        for member in archive:
            name = member.name.removeprefix('./').rstrip('/')
            assert not member.name.startswith('/') and '..' not in pathlib.PurePosixPath(name).parts
            assert member.isdir() or member.isfile(), name
            modes[name] = member.mode & 0o7777
            assert not member.mode & 0o6000, name
            if member.isdir():
                assert modes[name] & 0o111 == 0o111, name
                continue
            stream = archive.extractfile(member); digest = hashlib.sha256(); prefix = b''; saved = bytearray()
            keep = name in ('config.json', 'payload/runtime-lock.json', 'config/product.json', 'config/fonts.json', 'package.json', 'www/version.json', 'www/index.html', 'www/auth-callback.html')
            while chunk := stream.read(1024 * 1024):
                if not prefix: prefix = chunk[:64]
                digest.update(chunk)
                if keep: saved += chunk
            hashes[name] = digest.hexdigest()
            if keep: values[name] = saved.decode('utf-8') if name.endswith('.html') else json.loads(saved)
            if name == 'bin/node': values['nodeElf'] = prefix
            if name == 'bin/qibox-native': values['nativeElf'] = prefix
    return hashes, modes, values

reports = []
for argument in sys.argv[1:]:
    file = pathlib.Path(argument); outer = package_members(file)
    ugb = [name for name in outer if name.endswith('.ugb')]
    assert len(ugb) == 1, list(outer)
    hashes, modes, values = inspect_ugb(outer[ugb[0]])
    config = values['config.json']; arch = config['arch']; node_arch = {'amd64': 'x64', 'arm64': 'arm64'}[arch]
    assert config['appId'] == 'com.bot.qibox' and config['productSeries'] == 'nasync'
    assert config['version']['version'] == product['version'] + '.0001'
    assert values['config/product.json']['version'] == values['package.json']['version'] == values['www/version.json']['version'] == product['version']
    assert config['isDockerApp'] is False and config['baseAccessInfo']['openType'] == 'inner'
    environment = config['runtimeEnvironment']
    assert environment['service']['execStart'] == 'bin/node /var/packages/com.bot.qibox/server/ugos-entry.mjs'
    assert environment['proxy'] == [{'location': 'api/qibox', 'type': 'port', 'target': '28790'}]
    assert set(environment['permissions']) == {'SYSTEM.EXEC_SYSTEM_COMMAND', 'NETWORK.ACCESS_INTERNET'}
    assert modes['bin/node'] == 0o755 and modes['.check-app'] == 0o600
    assert modes['config.json'] == modes['www/index.html'] == 0o644
    elf = values['nodeElf']; assert elf[:6] == b'\x7fELF\x02\x01' and int.from_bytes(elf[18:20], 'little') == (183 if arch == 'arm64' else 62)
    node = root / 'build/qibox-ugos' / ('rootfs_' + arch) / 'bin/node'
    assert hashes['bin/node'] == hashlib.file_digest(node.open('rb'), 'sha256').hexdigest()
    native = json.loads((root / 'config/ugos-bootstrap-lock.json').read_text())
    assert hashes['bin/qibox-native'] == native['targets'][arch]['sha256'] and modes['bin/qibox-native'] == 0o755
    assert int.from_bytes(values['nativeElf'][18:20], 'little') == native['targets'][arch]['elf']
    assert hashes['native/ugos-namespace.c'] == native['sourceSha256']
    assert 'licenses/ugos-native/MUSL-COPYRIGHT' in hashes
    assert 'bin/NODE-LICENSE' in hashes
    lock = values['payload/runtime-lock.json']; assert lock['platform'] == 'linux-' + node_arch
    for item in lock['packages']: assert hashes['payload/' + item['file']] == item['sha256'], item['name']
    fonts = values['config/fonts.json']
    for item in fonts['fonts'] + fonts['licenses']: assert hashes[item['file']] == item['sha256'], item['file']
    assert hashes['icon.png'] == hashlib.sha256((root / 'build/qibox-ugos/rootfs_common/icon.png').read_bytes()).hexdigest()
    assert hashes['www/icon.png'] == hashes['public/icon.png'] == hashlib.sha256((root / 'web/icon.png').read_bytes()).hexdigest()
    for page in ('www/index.html', 'www/auth-callback.html'):
        for asset in re.findall(r'(?:src|href)=[\"\']\./([^\"\']+)[\"\']', values[page]):
            if not asset.split('?')[0].endswith(('.js', '.css', '.png')): continue
            filename, revision = asset.split('?v=')
            assert revision == hashes['www/' + filename][:16], asset
    for source in (root / 'server').iterdir():
        if source.is_file() and source.suffix in ('.mjs', '.py'):
            assert hashes['server/' + source.name] == hashlib.sha256(source.read_bytes()).hexdigest(), source.name
    for source in (root / 'public-ugos').rglob('*'):
        if source.is_file():
            name = source.relative_to(root / 'public-ugos').as_posix()
            assert hashes['www/' + name] == hashlib.sha256(source.read_bytes()).hexdigest(), name
            assert hashes['public/' + name] == hashes['www/' + name], name
    assert not any('opt/wechat' in name or name.endswith('.deb') for name in hashes)
    reports.append({'file': file.name, 'arch': arch, 'version': config['version']['version'], 'members': len(hashes), 'runtimeComponents': len(lock['packages']), 'nodeMode': oct(modes['bin/node']), 'nodeElf': int.from_bytes(elf[18:20], 'little'), 'status': 'passed', 'outerMembers': list(outer)})
    print(json.dumps(reports[-1]), flush=True)
(root / 'reports/upk-verification.json').write_text(json.dumps(reports, indent=2), encoding='utf-8')
