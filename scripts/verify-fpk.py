import hashlib, io, json, pathlib, re, sys, tarfile
fpk = pathlib.Path(sys.argv[1])
with tarfile.open(fpk, 'r:*') as package:
    manifest = {k.strip(): v.strip() for line in package.extractfile('manifest').read().decode().splitlines() if '=' in line for k, v in [line.split('=', 1)]}
    assert manifest['appname'] == 'qibox'
    assert manifest['desktop_applaunchname'] == 'qibox.Application'
    payload = package.extractfile('app.tgz').read()
    assert hashlib.md5(payload).hexdigest() == manifest['checksum']
    for member in package:
        if member.name.startswith('cmd/') and member.isfile():
            assert member.mode & 0o111 and b'\r\n' not in package.extractfile(member).read()
    with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as app:
        members, contents, hashes = {}, {}, {}
        # Shared archive filenames are hashes rather than dependency order.
        # Read the gzip stream once instead of repeatedly seeking backwards.
        for member in app:
            name = member.name.removeprefix('./'); members[name] = member
            if not member.isfile(): continue
            stream = app.extractfile(member)
            if name.startswith('payload/') and '-data.tar.' in name:
                hashes[name] = hashlib.file_digest(stream, 'sha256').hexdigest()
            else:
                contents[name] = stream.read()
        def read(name): return contents[name]
        backups = [name for name in members if re.search(r'\.(?:bak|before)(?:$|[.\-_])', pathlib.PurePosixPath(name).name, re.I)]
        assert not backups, backups
        config = json.loads(read('config/product.json'))
        assert config['appname'] == 'qibox' and config['gatewayPrefix'] == '/app/qibox'
        assert config['version'] == manifest['version'] == json.loads(read('package.json'))['version']
        entry = json.loads(read('ui/config'))['.url']['qibox.Application']
        assert entry['url'] == '/app/qibox/' and entry['gatewaySocket'] == 'app.sock'
        assert manifest['platform'] in ('x86', 'arm', 'all')
        assert config['platform'] == manifest['platform']
        forbidden = [name for name in members if re.search(r'(^|/)(wechat[^/]*\.(deb|xz|gz|rpm)|opt/wechat)', name, re.I)]
        assert not forbidden, forbidden
        arches = ['x64', 'arm64'] if manifest['platform'] == 'all' else ['arm64' if manifest['platform'] == 'arm' else 'x64']
        provenance = json.loads(read('payload/provenance.json')) if 'payload/provenance.json' in members else None
        verified_payloads = set()
        for arch in arches:
            prefix = 'payload/' + arch + '/'
            lock = json.loads(read(prefix + 'runtime-lock.json'))
            assert lock['platform'] == 'linux-' + arch and 'wechat' not in lock
            original_name = 'runtime-lock.json' if arch == 'x64' else 'runtime-lock-arm64.json'
            original = json.loads(read('config/' + original_name))
            assert [{k:v for k,v in item.items() if k not in ('payloadFile','payloadSha256')} for item in lock['packages']] == original['packages']
            for item in lock['packages']:
                filename, expected = prefix + item['file'], item['sha256']
                if lock.get('payloadFormat') == 2:
                    assert re.fullmatch(r'[a-f0-9]{64}', item['payloadSha256'])
                    assert item['payloadFile'] == item['payloadSha256'] + '-data.tar.xz'
                    filename, expected = 'payload/shared/' + item['payloadFile'], item['payloadSha256']
                    proof = provenance['components'][item['sha256']]
                    assert proof['file'] == item['payloadFile'] and proof['sha256'] == expected
                if filename not in verified_payloads:
                    assert hashes[filename] == expected
                    verified_payloads.add(filename)
        for name in ['server/index.mjs', 'server/install-deb.py', 'server/packages.mjs', 'server/progress.mjs', 'public/app.js', 'public/style.css', 'public/backgrounds/mist.jpg']:
            assert name in members
        for name in ['server/platform.mjs', 'server/desktop-stream.mjs', 'server/catalog.mjs', 'public/index.html', 'server/index.mjs', 'server/instances.mjs', 'server/packages.mjs', 'server/progress.mjs', 'server/files.mjs', 'server/install-deb.py', 'server/runtime.mjs', 'server/scheduler.mjs', 'server/auto-login.mjs', 'server/auto-login.py', 'server/accessibility-bus.py', 'public/app.js', 'public/style.css']:
            assert read(name) == (pathlib.Path(__file__).resolve().parent.parent / name).read_bytes(), name
        assert read('public/backgrounds/mist.jpg') == (pathlib.Path(__file__).resolve().parent.parent / 'web/backgrounds/mist.jpg').read_bytes()
        assert read('public/icon.png') == (pathlib.Path(__file__).resolve().parent.parent / 'web/icon.png').read_bytes()
        icon_revision = hashlib.sha256(read('public/icon.png')).hexdigest()[:16]
        for page in ['public/index.html', 'public/auth-callback.html']:
            assert f'./icon.png?v={icon_revision}'.encode() in read(page)
            assert b'"./icon.png"' not in read(page)
        assert entry['icon'] == f'images/qibox-{icon_revision}_{{0}}.png'
        assert read('server/fonts.mjs') == (pathlib.Path(__file__).resolve().parent.parent / 'server/fonts.mjs').read_bytes()
        for name in ['server/file-chooser.mjs', 'server/file-export.mjs', 'server/file-portal.py', 'server/login-state.mjs', 'server/desktop.mjs', 'server/ai-analysis.mjs', 'public/ai-workspace.css']:
            assert read(name) == (pathlib.Path(__file__).resolve().parent.parent / name).read_bytes(), name
        for name in ['ai-service.mjs', 'ai-data.mjs', 'wechat-data.py', 'wechat-sqlite.py', 'ai-schema.mjs', 'ai-provider.mjs', 'ai-presets.mjs', 'ai-capabilities.mjs', 'ai-native.mjs', 'ai-native.py', 'ai-native-controls.py', 'ai-native-render.py', 'ai-ledger.mjs', 'rfb-input.mjs']:
            assert read('server/' + name) == (pathlib.Path(__file__).resolve().parent.parent / 'server' / name).read_bytes(), name
        fonts = json.loads(read('config/fonts.json'))
        for item in fonts['fonts'] + fonts['licenses']:
            assert hashlib.sha256(read(item['file'])).hexdigest() == item['sha256'], item['file']
        for size, filename in [(64, 'ICON.PNG'), (256, 'ICON_256.PNG')]:
            assert read('ui/' + entry['icon'].replace('{0}', str(size))) == package.extractfile(filename).read()
        assert '接收设置' not in read('public/app.js').decode()
print('FPK verified: independent qibox identity, versions, Unix modes, all component hashes; no bundled WeChat.')
