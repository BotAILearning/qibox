"""Read-only component evidence from a live system or extracted official image.

This never infers an installed component from the system version. For images,
absolute symlinks resolve within the supplied root, never against the audit host.
A snapshot is evidence, not approval to remove a bundled fallback.
"""
import argparse
import hashlib
import importlib.util
import json
import pathlib

spec = importlib.util.spec_from_file_location('runtime_architecture', pathlib.Path(__file__).with_name('verify-runtime-architecture.py'))
elf = importlib.util.module_from_spec(spec)
spec.loader.exec_module(elf)


def resolve_image_path(root, name):
    root = pathlib.Path(root).resolve()
    if '\\' in name or '..' in pathlib.PurePosixPath(name).parts:
        raise ValueError('Unsafe system component path')
    parts = list(pathlib.PurePosixPath(name).parts)
    if parts and parts[0] == '/':
        parts.pop(0)
    traversed, links = [], 0
    while parts:
        part = parts.pop(0)
        if part in ('', '.'):
            continue
        if part == '..':
            if not traversed:
                raise ValueError('System link escapes image root')
            traversed.pop()
            continue
        candidate = root.joinpath(*traversed, part)
        if candidate.is_symlink():
            links += 1
            if links > 40:
                raise ValueError('System link cycle')
            target = candidate.readlink().as_posix()
            if target.startswith('/'):
                traversed = []
            parts = list(pathlib.PurePosixPath(target).parts[1:] if target.startswith('/') else pathlib.PurePosixPath(target).parts) + parts
        else:
            traversed.append(part)
    return root.joinpath(*traversed)


def packages(root, names):
    result = {}
    file = resolve_image_path(root, 'var/lib/dpkg/status')
    if not file.is_file():
        return result
    for block in file.read_text(errors='replace').split('\n\n'):
        fields = dict(line.split(': ', 1) for line in block.splitlines() if ': ' in line and not line.startswith(' '))
        if fields.get('Package') in names and fields.get('Status') == 'install ok installed':
            result[fields['Package']] = {k: fields.get(k) for k in ['Version', 'Architecture', 'Depends', 'Pre-Depends']}
    return result


def snapshot(root, manifest, source):
    root = pathlib.Path(root).resolve()
    arch = manifest['arch']
    machine = elf.ARCHES[arch]['machine']
    rows, canonical_files = {}, {}
    # Native programs and shared libraries are the ABI-sensitive subset. Source
    # manifests still independently pin every font, dictionary and data byte.
    for name, private in manifest['files'].items():
        if not (name.startswith(('usr/bin/', 'usr/sbin/', 'lib/', 'lib64/', 'usr/lib/')) and
                ('.so' in pathlib.PurePosixPath(name).name or name.startswith(('usr/bin/', 'usr/sbin/')))):
            continue
        try:
            file = resolve_image_path(root, name)
            if not file.is_file():
                rows[name] = {'status': 'missing'}
                continue
            canonical = file.relative_to(root).as_posix()
            if canonical not in canonical_files:
                data = file.read_bytes()
                info = elf.parse_elf(data)
                canonical_files[canonical] = {'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'elf': info}
            info = canonical_files[canonical]
            native = info['elf']
            rows[name] = {'status': 'present', 'canonical': canonical,
                          'identicalPrivateBytes': info['sha256'] == private['sha256'],
                          'correctArchitecture': native is not None and native['machine'] == machine}
        except (OSError, ValueError) as error:
            rows[name] = {'status': 'unusable', 'error': str(error)}
    versions = {}
    for name in ['etc/issue', 'etc/os-release', 'etc/debian_version']:
        file = resolve_image_path(root, name)
        if file.is_file():
            versions[name] = file.read_text(errors='replace')[:4096]
    return {'format': 1, 'source': source, 'arch': arch, 'runtimeIdentity': manifest['identity'],
            'systemVersionFiles': versions, 'packages': packages(root, {p['name'] for p in manifest['sources']}),
            'files': rows, 'canonicalFiles': canonical_files,
            'scope': 'Read-only file, package, ELF architecture, DT_NEEDED, and exact imported/exported symbol/version metadata. Not a loader or functional acceptance.',
            'minimumSystemVerified': False, 'fallbackRemovalApproved': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', type=pathlib.Path, required=True)
    parser.add_argument('--manifest', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, required=True)
    parser.add_argument('--source', required=True, help='Live system label or official image URL and independently verified hash')
    args = parser.parse_args()
    result = snapshot(args.root, json.loads(args.manifest.read_text('utf8')), args.source)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False) + '\n', encoding='utf8')
    print(json.dumps({'arch': result['arch'], 'checkedFiles': len(result['files']),
                      'nativeSystemComponents': sum(bool(v['elf']) for v in result['canonicalFiles'].values()),
                      'identicalPrivateFiles': sum(v.get('identicalPrivateBytes', False) for v in result['files'].values()),
                      'minimumSystemVerified': False, 'fallbackRemovalApproved': False}))


if __name__ == '__main__':
    main()
