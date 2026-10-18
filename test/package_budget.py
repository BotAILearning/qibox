import importlib.util
import io
import json
import pathlib
import tarfile
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('package_budget', ROOT / 'scripts/audit-package-budget.py')
budget_tool = importlib.util.module_from_spec(spec)
spec.loader.exec_module(budget_tool)


class PackageBudgetTests(unittest.TestCase):
    def build(self, folder, *, missing=False, arches=('x64', 'arm64')):
        payload = io.BytesIO()
        resource = 'a' * 64 + '.tar.xz'
        with tarfile.open(fileobj=payload, mode='w:gz') as app:
            entries = {'config/product.json': json.dumps({'buildId': 'fixture', 'minOSVersion': '1.2.0401'}).encode(),
                       'config/wechat.json': json.dumps({'downloads': {'x64': {'size': 100, 'version': 'official', 'sha256': 'b' * 64}}}).encode()}
            if not missing:
                entries['payload/resources/' + resource] = b'complete'
            for arch in arches:
                entries[f'payload/{arch}/runtime-manifest.json'] = json.dumps({'arch': arch, 'delivery': 'complete-bundled',
                    'resources': [{'file': resource, 'size': 8}]}).encode()
            for name, data in entries.items():
                member = tarfile.TarInfo(name)
                member.size = len(data)
                app.addfile(member, io.BytesIO(data))
        file = folder / 'complete.fpk'
        with tarfile.open(file, 'w:gz') as outer:
            data = payload.getvalue()
            member = tarfile.TarInfo('app.tgz')
            member.size = len(data)
            outer.addfile(member, io.BytesIO(data))
        return file

    def test_reports_unique_resources_and_keeps_download_and_disk_boundaries(self):
        with tempfile.TemporaryDirectory() as tmp:
            file = self.build(pathlib.Path(tmp))
            config = json.loads((ROOT / 'config/package-budget.json').read_text())
            result = budget_tool.measure(file, {**config, 'fullUniversalFpkExclusiveLimit': file.stat().st_size})
            self.assertFalse(result['sizePass'], 'limit is exclusive')
            self.assertEqual(result['uniqueCompressedRuntimeBytes'], 8, 'shared resource counted once')
            self.assertEqual(result['firstUse']['x64']['totalFileDownloadBytesWithNodeAlreadyInstalled'], file.stat().st_size + 100)
            self.assertIsNone(result['diskAllocationBytes'])
            self.assertFalse(result['functionalAcceptance'])
            self.assertFalse(result['attributionVerified'])

    def test_smaller_incomplete_resources_or_single_architecture_are_rejected(self):
        config = json.loads((ROOT / 'config/package-budget.json').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaisesRegex(ValueError, 'resources do not match'):
                budget_tool.measure(self.build(pathlib.Path(tmp), missing=True), config)
            with self.assertRaisesRegex(ValueError, 'dual-architecture'):
                budget_tool.measure(self.build(pathlib.Path(tmp), arches=('x64',)), config)


if __name__ == '__main__':
    unittest.main()
