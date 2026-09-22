"""Pack both architectures with official Linux ugcli in isolated build folders.

Usage: python scripts/pack-upk-ssh.py --host HOST --user USER
Password is read interactively and never written to a file.
"""
import argparse, getpass, hashlib, json, pathlib, re, shlex, sys, tarfile, time
root = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / '.cache/ssh-tools'))
import paramiko
parser = argparse.ArgumentParser(); parser.add_argument('--host', required=True); parser.add_argument('--user', required=True); parser.add_argument('--cleanup-draft'); args = parser.parse_args()
c = paramiko.SSHClient(); c.load_system_host_keys(); c.load_host_keys(str(pathlib.Path.home() / '.ssh/known_hosts'))
c.connect(args.host, username=args.user, password=getpass.getpass('SSH password: '), timeout=20, allow_agent=False, look_for_keys=False)
def command(cmd):
    _, out, err = c.exec_command(cmd)
    text = out.read().decode(); error = err.read().decode(); code = out.channel.recv_exit_status()
    if code: raise RuntimeError(f'{code}: {text[-2000:]} {error[-2000:]}')
    return text.strip()
if args.cleanup_draft:
    old = args.cleanup_draft
    assert re.fullmatch(r'/tmp/qibox-upk-build-[A-Za-z0-9]+', old)
    assert command('readlink -f ' + shlex.quote(old)) == old
    # The caller names one canceled build, and no process may still use it.
    probe = "import pathlib,sys; p=pathlib.Path(sys.argv[1]); active=[]\nfor x in pathlib.Path('/proc').iterdir():\n try:\n  q=(x/'cwd').resolve(strict=True)\n  if q == p or p in q.parents: active.append(x.name)\n except (OSError,RuntimeError): pass\nassert not active, active\n"
    command('python3 -c ' + shlex.quote(probe) + ' ' + shlex.quote(old))
    command('rm -rf -- ' + shlex.quote(old)); print('Canceled draft cleaned', flush=True)
remote = command('mktemp -d /tmp/qibox-upk-build-XXXXXXXX')
assert re.fullmatch(r'/tmp/qibox-upk-build-[A-Za-z0-9]+', remote)
report = {'builder': 'official ugcli 1.1.0.25 on Linux', 'remoteDirectory': remote, 'artifacts': [], 'existingApplicationModified': False}
jobs = {}; failures = []
try:
    archive = root / '.cache/qibox-ugos-inputs.tar.gz'
    def normalize(item):
        item.uid = item.gid = 0; item.uname = item.gname = ''
        item.mode = 0o755 if item.isdir() or item.name.endswith(('/bin/node', '/bin/qibox-native')) or item.name == 'ugcli-linux' else 0o644
        return item
    print('Preparing Linux build inputs', flush=True)
    with tarfile.open(archive, 'w:gz', compresslevel=1) as tar:
        for entry in (root / 'build/qibox-ugos').iterdir():
            if entry.name != 'build_dir': tar.add(entry, arcname=entry.name, filter=normalize)
    s = c.open_sftp(); last = [0]
    def progress(done, total):
        now = time.monotonic()
        if now - last[0] >= 20 or done == total: print(f'Transfer {done}/{total} bytes', flush=True); last[0] = now
    s.put(str(archive), remote + '/inputs.tar.gz', callback=progress)
    command(f'cd {shlex.quote(remote)} && tar -xzf inputs.tar.gz && ./ugcli-linux check')
    for arch in ['amd64', 'arm64']:
        folder = remote + '/job-' + arch
        command(f'cd {shlex.quote(remote)} && mkdir job-{arch} && cp project.yaml job-{arch}/ && cp -al rootfs_common rootfs_{arch} job-{arch}/')
        _, out, err = c.exec_command(f'cd {shlex.quote(folder)} && nice -n 10 ../ugcli-linux pack --arch {arch} --build 1')
        jobs[arch] = out.channel
    while jobs:
        for arch, channel in list(jobs.items()):
            for ready, receive in [(channel.recv_ready, channel.recv), (channel.recv_stderr_ready, channel.recv_stderr)]:
                while ready():
                    data = receive(8192).decode(errors='replace').strip()
                    if data: print(f'{arch}: {data}', flush=True)
            if channel.exit_status_ready():
                code = channel.recv_exit_status()
                del jobs[arch]
                if code: failures.append(f'{arch} ugcli exited {code}')
                else: print(f'{arch}: official pack completed', flush=True)
        if jobs: time.sleep(2)
    if failures: raise RuntimeError('; '.join(failures))
    paths = command(f'find {shlex.quote(remote)} -type f -name "*.upk"').splitlines(); assert len(paths) == 2
    for file in paths:
        assert file.startswith(remote + '/')
        dest = root / 'dist' / pathlib.PurePosixPath(file).name
        s.get(file, str(dest), callback=progress)
        digest = hashlib.file_digest(dest.open('rb'), 'sha256').hexdigest()
        assert command('sha256sum ' + shlex.quote(file)).split()[0] == digest
        dest.with_suffix('.upk.sha256').write_text(f'{digest}  {dest.name}\n')
        report['artifacts'].append({'file': dest.name, 'bytes': dest.stat().st_size, 'sha256': digest})
    report['status'] = 'passed'
finally:
    # No application directories or user profiles are touched by this helper.
    if not jobs and command('readlink -f ' + shlex.quote(remote)) == remote:
        command('rm -rf -- ' + shlex.quote(remote)); report['scratchRemoved'] = True
    else: report['scratchRemoved'] = False
    c.close()
    (root / 'reports/ugos-linux-pack.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report), flush=True)
