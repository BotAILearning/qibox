import hashlib, pathlib, sys, tarfile
archive, target, expected = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2]), int(sys.argv[3])
target.mkdir(parents=True, exist_ok=True)
with tarfile.open(archive) as source:
    binary = next(m for m in source if m.name.endswith('/bin/node'))
    data = source.extractfile(binary).read()
    assert data[:6] == b'\x7fELF\x02\x01' and int.from_bytes(data[18:20], 'little') == expected
    (target / 'node').write_bytes(data)
    (target / 'node').chmod(0o755)
    license = next(m for m in source if m.name.endswith('/LICENSE'))
    (target / 'NODE-LICENSE').write_bytes(source.extractfile(license).read())
print(f'Node ELF verified: {expected}, {len(data)} bytes')
