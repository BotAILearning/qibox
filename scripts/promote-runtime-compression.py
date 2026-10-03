"""Promote smaller archives only when their entire decoded tar is identical."""
import hashlib
import importlib.util
import json
import lzma
import pathlib
import re
import shutil
import sys

spec = importlib.util.spec_from_file_location('solid', pathlib.Path(__file__).with_name('prepare-runtime-solid.py'))
solid = importlib.util.module_from_spec(spec)
spec.loader.exec_module(solid)


def decoded_digest(file):
    digest = hashlib.sha256()
    with lzma.LZMAFile(file, 'r') as stream:
        while block := stream.read(1024 * 1024):
            digest.update(block)
    return digest.hexdigest()


def main():
    proof_path = solid.OUT / 'provenance.json'
    provenance = json.loads(proof_path.read_text('utf8'))
    saved = {}
    for label, path in zip(['common', 'arm64'], sys.argv[1:], strict=True):
        experiment_path = pathlib.Path(path)
        experiment = json.loads(experiment_path.read_text('utf8'))
        original = provenance['groups'][label]
        if experiment['source'] != original['file'] or experiment['filter'] != 'none' or experiment['preset'] != '9e':
            raise ValueError('Compression experiment does not match current source')
        if not re.fullmatch(r'[a-f0-9]{64}', experiment['sha256']) or experiment['file'] != experiment['sha256'] + '-data.tar.xz':
            raise ValueError('Unsafe experiment archive')
        source = solid.OUT / 'shared' / original['file']
        candidate = experiment_path.parent / experiment['file']
        if solid.digest(source) != original['sha256'] or solid.digest(candidate) != experiment['sha256']:
            raise ValueError('Compression archive digest changed')
        if decoded_digest(source) != experiment['tarSha256'] or decoded_digest(candidate) != experiment['tarSha256']:
            raise ValueError('Compression changed the complete decoded tar stream')
        if candidate.stat().st_size != experiment['bytes'] or experiment['bytes'] >= original['bytes']:
            raise ValueError('Candidate is not smaller')
        shutil.copyfile(candidate, solid.OUT / 'shared' / experiment['file'])
        saved[label] = original['bytes'] - experiment['bytes']
        provenance['groups'][label] = {**original, 'file': experiment['file'], 'sha256': experiment['sha256'],
                                      'bytes': experiment['bytes'], 'compression': 'lzma2-9e'}
    locks = {arch: json.loads((solid.ROOT / 'config' / name).read_text('utf8')) for arch, name in [('x64', 'runtime-lock.json'), ('arm64', 'runtime-lock-arm64.json')]}
    provenance['fingerprint'] = solid.runtime_fingerprint(locks, provenance['policy'], 9 | lzma.PRESET_EXTREME)
    provenance['bytes'] = sum(p['bytes'] for p in provenance['groups'].values())
    for arch, lock in locks.items():
        lock['payloadFormat'] = 3
        lock['archives'] = [{'payloadFile': provenance['groups'][g]['file'], 'payloadSha256': provenance['groups'][g]['sha256']} for g in ['common', arch]]
        (solid.OUT / arch / 'runtime-lock.json').write_text(json.dumps(lock, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    proof_path.write_text(json.dumps(provenance, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({'promoted': saved, 'savedBytes': sum(saved.values()), 'bytes': provenance['bytes']}), flush=True)


if __name__ == '__main__':
    main()
