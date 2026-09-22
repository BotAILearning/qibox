"""Create an immutable source archive for the current Debug build."""
import argparse, hashlib, json, pathlib, zipfile

root = pathlib.Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--report', default='reports/development-2026-09-15-batch2')
args = parser.parse_args()
product = json.loads((root/'config/product.json').read_text('utf8'))
assert product['channel'] == 'debug'
build = product['buildId']; output = root/'dist/releases'/product['version']/build
source = output/f'qibox-{build}-source.zip'
assert (output/f'qibox-{build}-all.fpk').is_file()
files = [root/n for n in ['.gitignore','README.md','NOTICE.md','package.json','package-lock.json','design-qa.md','AI辅助-产品演示.html'] if (root/n).is_file()]
excluded = {'.git','.cache','.dev-data','dist','node_modules','__pycache__'}
for folder in ['server','web','scripts','test','config','packaging','native','fonts','licenses','design','docs','public']:
    files.extend(p for p in (root/folder).rglob('*') if p.is_file() and not excluded.intersection(p.relative_to(root).parts) and p.suffix != '.pyc')
report = (root/args.report).resolve()
assert report.is_relative_to(root/'reports') and report.is_dir()
for name in ['PROGRESS.md','ACCEPTANCE.md','DELIVERY.md','node-regression.txt','python-regression.txt','check.txt','stage-build.txt','package-build.txt','package-scope.json']:
    assert (report/name).is_file(), name
files.extend(p for p in report.iterdir() if p.is_file() and p.suffix in {'.md','.txt','.json','.diff'})
for browser_dir in report.glob('browser*'):
    if browser_dir.is_dir(): files.extend(browser_dir.glob('*'))
manifest = {}
with zipfile.ZipFile(source, 'x', compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
    for file in sorted(set(files)):
        assert file.is_file() and not file.is_symlink() and file.resolve().is_relative_to(root), file
        name = file.relative_to(root).as_posix(); data = file.read_bytes()
        assert not excluded.intersection(pathlib.PurePosixPath(name).parts), name
        manifest[name] = {'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
        archive.writestr(name, data)
    manifest_bytes = (json.dumps({'buildId':build,'files':manifest}, ensure_ascii=False, indent=2)+'\n').encode('utf8')
    archive.writestr('SOURCE-MANIFEST.json', manifest_bytes)
(output/'SOURCE-MANIFEST.json').write_bytes(manifest_bytes)
with zipfile.ZipFile(source) as archive:
    assert archive.testzip() is None
    for name, expected in manifest.items(): assert hashlib.sha256(archive.read(name)).hexdigest() == expected['sha256'], name
artifacts = {}
for file in [output/f'qibox-{build}-all.fpk',source,output/'SOURCE-MANIFEST.json']:
    with file.open('rb') as stream: digest = hashlib.file_digest(stream,'sha256').hexdigest()
    artifacts[file.name] = {'bytes':file.stat().st_size,'sha256':digest}
(output/'SHA256SUMS.txt').write_text(''.join(f"{v['sha256']}  {n}\n" for n,v in artifacts.items()), encoding='utf8')
result = {'buildId':build,'sourceFiles':len(manifest),'artifacts':artifacts}
(output/'ARTIFACTS.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n', encoding='utf8')
print(json.dumps(result,ensure_ascii=False))
