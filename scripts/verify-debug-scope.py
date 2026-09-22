"""Inspect the shipped FPK and every nested runtime archive for retired demos."""
import hashlib, io, json, pathlib, re, sys, tarfile

file = pathlib.Path(sys.argv[1])
expected_build = sys.argv[2] if len(sys.argv) > 2 else json.loads((pathlib.Path(__file__).resolve().parents[1]/'config/product.json').read_text('utf8'))['buildId']
with tarfile.open(file, 'r:gz') as outer:
    payload = outer.extractfile('app.tgz').read()
with tarfile.open(fileobj=io.BytesIO(payload), mode='r:gz') as app:
    members = {m.name.removeprefix('./'):m for m in app}
    product = json.loads(app.extractfile(members['config/product.json']).read())
    assert product['channel'] == 'debug'
    assert product['buildId'] == expected_build
    retired = re.compile(rb'calculator|static-site|xcalc|x11-apps')
    text_files = 0; components = 0
    for name, member in members.items():
        if not member.isfile(): continue
        assert not re.search(r'(^|/)(?:test|tests|\.cache)/', name), name
        if name.startswith(('server/', 'public/', 'config/')) and name.endswith(('.mjs','.py','.js','.json','.html')):
            assert not retired.search(app.extractfile(member).read()), name
            text_files += 1
        if name.startswith('payload/') and '-data.tar.' in name:
            with tarfile.open(fileobj=io.BytesIO(app.extractfile(member).read()), mode='r:*') as nested:
                for entry in nested:
                    assert not re.search(r'(^|/)(?:xcalc|x11-apps|calculator|static-site)(?:/|$)', entry.name), (name, entry.name)
            components += 1
    locks = [json.loads(app.extractfile(m).read()) for n,m in members.items() if n.startswith('payload/') and n.endswith('/runtime-lock.json')]
    references = sum(len(lock['packages']) for lock in locks)
    expected_archives = {('payload/shared/' + item['payloadFile']) if lock.get('payloadFormat') == 2 else ('payload/' + lock['platform'].removeprefix('linux-') + '/' + item['file']) for lock in locks for item in lock['packages']}
    assert references == 737 and len(locks) == 2, references
    assert components == len(expected_archives), components
    for name in ['server/ai-memory.mjs','server/ai-native-voice.py','server/ai-contact-order.mjs']:
        assert name in members
print(json.dumps({'buildId':product['buildId'],'textFilesChecked':text_files,'runtimeReferences':references,'runtimeArchivesChecked':components,'retiredExamplesAbsent':True,'bytes':file.stat().st_size,'sha256':hashlib.file_digest(file.open('rb'),'sha256').hexdigest()}))
