"""Losslessly archive application fonts and server dependencies for installation."""
import hashlib,json,lzma,pathlib,sys,tarfile


def digest(file):
    with file.open('rb') as stream:return hashlib.file_digest(stream,'sha256').hexdigest()


def prepare(app):
    app=pathlib.Path(app).resolve();output=app/'assets';output.mkdir(exist_ok=True)
    files={};directories=set()
    for folder in ['fonts','node_modules']:
        for file in sorted((app/folder).rglob('*')):
            name=file.relative_to(app).as_posix()
            if file.is_symlink():raise ValueError('Application assets cannot contain links: '+name)
            if file.is_dir():directories.add(name);continue
            if not file.is_file():raise ValueError('Unsupported application asset: '+name)
            files[name]={'bytes':file.stat().st_size,'sha256':digest(file),'mode':0o644}
        directories.add(folder)
    if not files or not any(p.startswith('fonts/') for p in files) or not any(p.startswith('node_modules/') for p in files):raise ValueError('Application assets are incomplete')
    pending=output/'app-assets.pending.tar.xz'
    with lzma.LZMAFile(pending,'w',filters=[{'id':lzma.FILTER_LZMA2,'preset':9|lzma.PRESET_EXTREME,'lc':4,'lp':0,'pb':0}],check=lzma.CHECK_SHA256) as compressed:
        with tarfile.open(fileobj=compressed,mode='w|',format=tarfile.PAX_FORMAT) as archive:
            for name in sorted(directories):
                member=tarfile.TarInfo(name);member.type=tarfile.DIRTYPE;member.mode=0o755;archive.addfile(member)
            for name,item in sorted(files.items(),key=lambda pair:(pathlib.PurePosixPath(pair[0]).suffix,pair[0])):
                member=tarfile.TarInfo(name);member.size=item['bytes'];member.mode=item['mode']
                with (app/name).open('rb') as stream:archive.addfile(member,stream)
    restored={};actual_directories=set()
    with tarfile.open(pending) as archive:
        for member in archive:
            if member.isdir():actual_directories.add(member.name);continue
            if not member.isfile():raise ValueError('Unexpected archived asset type')
            restored[member.name]={'bytes':member.size,'sha256':hashlib.file_digest(archive.extractfile(member),'sha256').hexdigest(),'mode':member.mode}
    if restored!=files or actual_directories!=directories:raise ValueError('Application asset round trip differs')
    hashed=digest(pending);filename=hashed+'-assets.tar.xz';pending.replace(output/filename)
    manifest={'format':1,'file':filename,'sha256':hashed,'bytes':(output/filename).stat().st_size,'files':files,'directories':sorted(directories)}
    (app/'config/app-assets.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n',encoding='utf8')
    print(json.dumps({'applicationAssets':len(files),'rawBytes':sum(v['bytes'] for v in files.values()),'archiveBytes':manifest['bytes'],'sha256':hashed}),flush=True)
    return manifest


if __name__=='__main__':prepare(sys.argv[1])
