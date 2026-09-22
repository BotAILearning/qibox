"""Create verified, content-addressed fnOS payloads; preserve original provenance."""
import concurrent.futures, hashlib, io, json, pathlib, posixpath, re, shutil, tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]
CACHE = ROOT/'.cache/size-audit-040'
OUT = ROOT/'.cache/runtime-slim'

def sha(data): return hashlib.sha256(data).hexdigest()
def signature(m, data): return (m.name, m.type, m.mode, m.uid, m.gid, m.linkname, m.size, sha(data) if data is not None else None)
def removable(m):
    n=m.name.removeprefix('./')
    return (m.isfile() or m.issym() or m.islnk()) and (n.startswith('usr/share/man/') or n.startswith('usr/share/doc/') and re.fullmatch(r'(?:changelog(?:\.[^/]+)?|NEWS(?:\.[^/]+)?)',pathlib.PurePosixPath(n).name,re.I))

def verify_retained(raw, encoded):
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:*') as src, tarfile.open(fileobj=io.BytesIO(encoded), mode='r:*') as dst:
        original=src.getmembers(); retained=dst.getmembers(); names={m.name for m in retained}
        removed=[m for m in original if m.name not in names]
        if any(not removable(m) for m in removed): raise ValueError('Runtime content removed')
        expected=[signature(m,src.extractfile(m).read() if m.isfile() else None) for m in original if m.name in names]
        actual=[signature(m,dst.extractfile(m).read() if m.isfile() else None) for m in retained]
        if actual!=expected: raise ValueError('Retained archive content differs')
        dropped={posixpath.normpath(m.name) for m in removed}
        for m in retained:
            if m.issym() or m.islnk():
                target=posixpath.normpath(posixpath.join(posixpath.dirname(m.name),m.linkname)) if m.issym() else posixpath.normpath(m.linkname)
                if target in dropped: raise ValueError('Retained link target removed')
        return len(retained)

def slim(source, expected):
    raw=source.read_bytes()
    if sha(raw)!=expected: raise ValueError('Original archive hash mismatch: '+source.name)
    CACHE.mkdir(parents=True,exist_ok=True)
    cached=CACHE/(expected+'.xz'); metadata=CACHE/(expected+'.json')
    if metadata.is_file():
        info=json.loads(metadata.read_text('utf8'))
        if info.get('sha256')==expected:
            if not info.get('changed'): return raw, info
            if cached.is_file() and sha(cached.read_bytes())==info.get('slim_sha256'):
                encoded=cached.read_bytes()
                try:
                    info['verified_retained']=verify_retained(raw,encoded)
                    return encoded,info
                except ValueError: pass
    with tarfile.open(fileobj=io.BytesIO(raw),mode='r:*') as src:
        members=src.getmembers(); drop={m.name for m in members if removable(m)}
        # Preserve every transitive target of any retained hard/symbolic link.
        changed=True
        while changed:
            changed=False
            for m in members:
                if m.name in drop or not (m.issym() or m.islnk()): continue
                target=posixpath.normpath(posixpath.join(posixpath.dirname(m.name),m.linkname)) if m.issym() else m.linkname
                for name in (target,'./'+target.removeprefix('./')):
                    if name in drop: drop.remove(name);changed=True
        if not drop: return raw,{'sha256':expected,'changed':False,'removed':[],'verified_retained':0}
        output=io.BytesIO(); retained=[]; removed=[]
        with tarfile.open(fileobj=output,mode='w:xz',preset=6,format=tarfile.PAX_FORMAT) as dst:
            for m in members:
                if m.name in drop: removed.append({'path':m.name,'bytes':m.size});continue
                data=src.extractfile(m).read() if m.isfile() else None
                retained.append(signature(m,data));dst.addfile(m,io.BytesIO(data) if data is not None else None)
    encoded=output.getvalue()
    with tarfile.open(fileobj=io.BytesIO(encoded),mode='r:*') as check:
        if [signature(m,check.extractfile(m).read() if m.isfile() else None) for m in check]!=retained: raise ValueError('Retained content mismatch')
    info={'sha256':expected,'slim_sha256':sha(encoded),'changed':True,'removed':removed,'verified_retained':len(retained)}
    cached.write_bytes(encoded);metadata.write_text(json.dumps(info,ensure_ascii=False),encoding='utf8')
    return encoded,info

def main():
    shared=OUT/'shared';shared.mkdir(parents=True,exist_ok=True)
    locks={}; sources={}
    for arch,name in [('x64','runtime-lock.json'),('arm64','runtime-lock-arm64.json')]:
        lock=json.loads((ROOT/'config'/name).read_text('utf8'));locks[arch]=lock
        for item in lock['packages']:
            source=ROOT/('.cache/runtime' if arch=='x64' else '.cache/runtime-arm64')/item['file']
            sources.setdefault(item['sha256'],source)
    def prepare(pair):
        original,source=pair;encoded,info=slim(source,original);hashed=sha(encoded);name=hashed+'-data.tar.xz';dest=shared/name
        if not dest.exists():dest.write_bytes(encoded)
        elif sha(dest.read_bytes())!=hashed:raise ValueError('Cached payload mismatch')
        return original,{'file':name,'sha256':hashed,'bytes':len(encoded),'sourceFile':source.name,'removed':info['removed'],'verifiedRetained':info.get('verified_retained',0)}
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool: prepared=dict(pool.map(prepare,sources.items()))
    for arch,lock in locks.items():
        for item in lock['packages']:
            payload=prepared[item['sha256']];item['payloadFile']=payload['file'];item['payloadSha256']=payload['sha256']
        lock['payloadFormat']=2
        folder=OUT/arch;folder.mkdir(exist_ok=True);(folder/'runtime-lock.json').write_text(json.dumps(lock,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    report={'format':2,'references':sum(len(x['packages']) for x in locks.values()),'archives':len(prepared),'bytes':sum(x['bytes'] for x in prepared.values()),'components':prepared}
    (OUT/'provenance.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf8')
    print(json.dumps({k:v for k,v in report.items() if k!='components'}))

if __name__=='__main__': main()
