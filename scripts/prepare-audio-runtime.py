"""Add private PulseAudio support from Debian indices; never install on host."""
import concurrent.futures, hashlib, json, lzma, pathlib, re, urllib.request
ROOT=pathlib.Path(__file__).resolve().parents[1]
CACHE=ROOT/'.cache/audio-resolver'; CACHE.mkdir(parents=True,exist_ok=True)
def fetch(url,file,sha=None):
 if file.exists():
  data=file.read_bytes()
  if sha is None or hashlib.sha256(data).hexdigest()==sha:return data
 with urllib.request.urlopen(url,timeout=60) as response:data=response.read()
 if sha and hashlib.sha256(data).hexdigest()!=sha:raise ValueError('Debian checksum mismatch')
 file.write_bytes(data);return data
def fields(text):
 result={};key=None
 for line in text.splitlines():
  if line.startswith(' ') and key:result[key]+=' '+line.strip()
  elif ': ' in line:key,value=line.split(': ',1);result[key]=value
 return result
for arch,suffix,payload in [('amd64','', 'runtime'),('arm64','-arm64','runtime-arm64')]:
 lockfile=ROOT/f'config/runtime-lock{suffix}.json';lock=json.loads(lockfile.read_text())
 packages={}
 for label,base,suite in [('main','https://deb.debian.org/debian/','bookworm'),('security','https://security.debian.org/debian-security/','bookworm-security')]:
  data=fetch(f'{base}dists/{suite}/main/binary-{arch}/Packages.xz',CACHE/f'{arch}-{label}.xz')
  for item in lzma.decompress(data).decode().split('\n\n'):
   entry=fields(item)
   if 'Package' in entry:entry['url']=base+entry['Filename'];packages[entry['Package']]=entry
 existing={p['name'] for p in lock['packages']};host=set(lock['hostPackages']);selected={};pending=['pulseaudio']
 providers={}
 for name,entry in packages.items():
  for item in entry.get('Provides','').split(','):
   key=item.strip().split(' ',1)[0]
   if key:providers[key]=name
 while pending:
  name=pending.pop()
  if name in selected or name in existing or name in host:continue
  entry=packages[name];selected[name]=entry
  for group in (entry.get('Pre-Depends','')+','+entry.get('Depends','')).split(','):
   if not group.strip():continue
   alts=[re.split(r'[\s:(\[]',p.strip(),1)[0] for p in group.split('|')]
   if any(x in host or x in existing or x in selected or providers.get(x) in host|existing|set(selected) for x in alts):continue
   choice=next((x for x in alts if x in packages),None)
   choice=choice or next((providers[x] for x in alts if x in providers),None)
   if not choice:raise ValueError(f'Unresolved dependency {name}: {group}')
   pending.append(choice)
 def prepare(entry):
  data=fetch(entry['url'],CACHE/pathlib.PurePosixPath(entry['Filename']).name,entry['SHA256'])
  if data[:8]!=b'!<arch>\n':raise ValueError('Invalid Debian archive')
  pos=8
  while pos+60<=len(data):
   member=data[pos:pos+16].decode().strip().rstrip('/');size=int(data[pos+48:pos+58]);content=data[pos+60:pos+60+size]
   if member.startswith('data.tar'):
    filename=entry['Package']+'-'+member;(ROOT/'.cache'/payload/filename).write_bytes(content)
    return dict(name=entry['Package'],version=entry['Version'],architecture=entry['Architecture'],url=entry['url'],debSha256=entry['SHA256'],file=filename,sha256=hashlib.sha256(content).hexdigest())
   pos+=60+size+size%2
  raise ValueError('Missing payload')
 with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:added=list(pool.map(prepare,selected.values()))
 lock['packages']=sorted(lock['packages']+added,key=lambda x:x['name']);lockfile.write_text(json.dumps(lock,indent=2)+'\n')
 print(json.dumps({'architecture':arch,'added':[p['name'] for p in added]}),flush=True)
