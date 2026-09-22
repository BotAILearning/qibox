import importlib.util, io, json, pathlib, subprocess, sys, tarfile, tempfile, unittest
spec = importlib.util.spec_from_file_location('installer', pathlib.Path(__file__).resolve().parents[1] / 'server/install-deb.py')
installer = importlib.util.module_from_spec(spec); spec.loader.exec_module(installer)

class Extraction(unittest.TestCase):
    def archive(self, records):
        result = io.BytesIO()
        with tarfile.open(fileobj=result, mode='w') as stream:
            for name, link in records:
                item = tarfile.TarInfo(name)
                if link is not None: item.type = tarfile.SYMTYPE; item.linkname = link
                else: item.size = 4; item.mode = 0o755
                stream.addfile(item, None if link is not None else io.BytesIO(b'test'))
        result.seek(0)
        return tarfile.open(fileobj=result, mode='r:')
    def check_invalid(self, records):
        with tempfile.TemporaryDirectory(prefix='qibox-extract-test-') as directory, self.archive(records) as stream:
            with self.assertRaises(ValueError): installer.extract(stream, stream.getmembers(), pathlib.Path(directory))
    def test_path_traversal(self): self.check_invalid([('opt/wechat/../../escape', None)])
    def test_absolute_path(self): self.check_invalid([('/tmp/escape', None)])
    def test_escaping_symlink(self): self.check_invalid([('opt/wechat/link', '../../../outside')])
    def test_symlink_parent(self): self.check_invalid([('opt/wechat/a', 'b'), ('opt/wechat/a/file', None)])
    def test_duplicate(self): self.check_invalid([('opt/wechat/wechat', None), ('opt/wechat/wechat', None)])
    def test_only_application_files(self):
        with tempfile.TemporaryDirectory(prefix='qibox-extract-test-') as directory, self.archive([('opt/wechat/wechat', None), ('etc/profile', None)]) as stream:
            target = pathlib.Path(directory); installer.extract(stream, stream.getmembers(), target)
            self.assertEqual((target / 'opt/wechat/wechat').read_bytes(), b'test'); self.assertFalse((target / 'etc').exists())
    def test_progress_counts_only_files_actually_extracted(self):
        with tempfile.TemporaryDirectory(prefix='qibox-extract-test-') as directory, self.archive([('opt/wechat/wechat', None), ('etc/profile', None), ('opt/wechat/data', None)]) as stream:
            events = []
            installer.extract(stream, stream.getmembers(), pathlib.Path(directory), lambda written, total: events.append((written, total)))
            self.assertEqual(events, [(0, 8), (4, 8), (8, 8)])
    def test_cli_reports_incremental_bytes_and_final_metadata(self):
        def tar(name, data):
            result = io.BytesIO()
            with tarfile.open(fileobj=result, mode='w') as stream:
                member = tarfile.TarInfo(name); member.size = len(data); stream.addfile(member, io.BytesIO(data))
            return result.getvalue()
        elf = bytearray(3 * 1024 * 1024); elf[:6] = b'\x7fELF\x02\x01'; elf[18:20] = b'\x3e\x00'
        members = [('debian-binary', b'2.0\n'), ('control.tar', tar('control', b'Package: wechat\nArchitecture: amd64\nVersion: 4.1.13.9\n')), ('data.tar', tar('opt/wechat/wechat', elf))]
        package = bytearray(b'!<arch>\n')
        for name, data in members:
            package += f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(data):<10}`\n'.encode('ascii') + data
            if len(data) % 2: package += b'\n'
        with tempfile.TemporaryDirectory(prefix='qibox-extract-test-') as directory:
            base = pathlib.Path(directory); file = base / 'wechat.deb'; file.write_bytes(package); target = base / 'output'; target.mkdir()
            output = subprocess.check_output([sys.executable, spec.origin, str(file), str(target)], text=True, encoding='utf-8')
            events = [json.loads(line) for line in output.splitlines()]
            self.assertEqual(events[0], {'type': 'progress', 'stage': 'extracting', 'bytes': 0, 'total': len(elf)})
            self.assertEqual(events[-2]['bytes'], len(elf)); self.assertEqual(events[-1]['version'], '4.1.13.9')
            self.assertEqual((target / 'opt/wechat/wechat').read_bytes(), elf)

    def test_arm64_requires_matching_control_and_real_elf_machine(self):
        def tar(name, data):
            result = io.BytesIO()
            with tarfile.open(fileobj=result, mode='w') as stream:
                member = tarfile.TarInfo(name); member.size = len(data); stream.addfile(member, io.BytesIO(data))
            return result.getvalue()
        for control, machine, accepted in [('arm64', 183, True), ('amd64', 183, False), ('arm64', 62, False)]:
            with self.subTest(control=control, machine=machine), tempfile.TemporaryDirectory(prefix='qibox-arm-extract-') as directory:
                elf = bytearray(64); elf[:6] = b'\x7fELF\x02\x01'; elf[18:20] = machine.to_bytes(2, 'little')
                members = [('debian-binary', b'2.0\n'), ('control.tar', tar('control', f'Package: wechat\nArchitecture: {control}\nVersion: 4.1.13.9\n'.encode())), ('data.tar', tar('opt/wechat/wechat', elf))]
                package = bytearray(b'!<arch>\n')
                for name, data in members:
                    package += f'{name + "/":<16}{0:<12}{0:<6}{0:<6}{100644:<8}{len(data):<10}`\n'.encode('ascii') + data
                    if len(data) % 2: package += b'\n'
                base = pathlib.Path(directory); file = base / 'wechat.deb'; file.write_bytes(package); target = base / 'output'; target.mkdir()
                if accepted:
                    result = installer.inspect_and_extract(file, target, architecture='arm64')
                    self.assertEqual(result['arch'], 'arm64')
                    self.assertEqual((target / 'opt/wechat/wechat').read_bytes(), elf)
                else:
                    with self.assertRaises(ValueError): installer.inspect_and_extract(file, target, architecture='arm64')

if __name__ == '__main__': unittest.main()
