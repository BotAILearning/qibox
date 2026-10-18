"""Measure the complete FPK; never substitute runtime disk savings for download.

The report is a size gate, not a release/functional acceptance result. Component
removal attribution and device evidence remain independently required.
"""
import argparse
import collections
import hashlib
import json
import pathlib
import tarfile

ROOT = pathlib.Path(__file__).resolve().parents[1]


def measure(fpk, budget):
    fpk = pathlib.Path(fpk)
    with fpk.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    categories = collections.Counter()
    resources, manifests, clients, product = {}, {}, None, None
    with tarfile.open(fpk) as outer:
        with tarfile.open(fileobj=outer.extractfile('app.tgz'), mode='r|gz') as app:
            for member in app:
                if not member.isfile():
                    continue
                name = member.name.removeprefix('./')
                category = name.split('/')[0]
                categories[category] += member.size
                if name.startswith('payload/resources/'):
                    if name in resources:
                        raise ValueError('Duplicated resource path')
                    resources[name] = member.size
                elif name in ['payload/x64/runtime-manifest.json', 'payload/arm64/runtime-manifest.json']:
                    manifests[name.split('/')[1]] = json.load(app.extractfile(member))
                elif name == 'config/wechat.json':
                    clients = json.load(app.extractfile(member))
                elif name == 'config/product.json':
                    product = json.load(app.extractfile(member))
    if set(manifests) != set(budget['architectures']):
        raise ValueError('Budget applies only to a complete dual-architecture FPK')
    expected = {}
    for arch, manifest in manifests.items():
        if manifest['arch'] != arch or manifest['delivery'] != 'complete-bundled':
            raise ValueError('Incomplete runtime delivery')
        for resource in manifest['resources']:
            name = 'payload/resources/' + resource['file']
            if name in expected and expected[name] != resource['size']:
                raise ValueError('Architecture resource sizes disagree')
            expected[name] = resource['size']
    if resources != expected:
        raise ValueError('Complete unique runtime resources do not match manifests')
    if not product or product['minOSVersion'] != budget['minimumSystem']:
        raise ValueError('Minimum system support boundary changed')
    size = fpk.stat().st_size
    report = {
        'format': 1, 'buildId': product['buildId'], 'fpkBytes': size, 'fpkSha256': digest,
        'baselineFpkBytes': budget['baseline']['fpkBytes'],
        'deltaFromBaselineBytes': size - budget['baseline']['fpkBytes'],
        'deltaFromFailedCandidateBytes': size - budget['failedCandidate']['fpkBytes'],
        'exclusiveLimitBytes': budget['fullUniversalFpkExclusiveLimit'],
        'sizePass': size < budget['fullUniversalFpkExclusiveLimit'],
        'uniqueCompressedRuntimeBytes': sum(resources.values()),
        'uniqueCompressedRuntimeResources': len(resources),
        'applicationTarFileBytesByCategory': dict(sorted(categories.items())),
        'cachedUpgradeDownloadBytes': size,
        'cachedUpgradeBoundary': 'Existing valid official WeChat and official Node dependency; no store delta update assumed',
        'firstUse': {},
        'officialNodeDependencyDownloadBytes': None,
        'officialNodeBoundary': '0 only when official Node dependency is already installed; otherwise measure separately',
        'diskAllocationBytes': None, 'temporaryPeakBytes': None,
        'attributionVerified': False, 'functionalAcceptance': False,
        'minimumSystemDeviceAcceptance': False, 'armDeviceAcceptance': False,
        'boundary': budget['boundary'],
    }
    # Preserve the product's pinned official-client source/size/identity. It is
    # never included in bundled runtime savings or silently counted as zero.
    if clients:
        for arch, entry in clients.get('downloads', {}).items():
            report['firstUse'][arch] = {'officialWechatBytes': entry['size'],
                'officialWechatVersion': entry['version'], 'officialWechatSha256': entry['sha256'],
                'totalFileDownloadBytesWithNodeAlreadyInstalled': size + entry['size']}
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('fpk', type=pathlib.Path)
    parser.add_argument('--report-only', action='store_true')
    args = parser.parse_args()
    budget = json.loads((ROOT / 'config/package-budget.json').read_text('utf8'))
    report = measure(args.fpk, budget)
    target = args.fpk.with_suffix('.budget.json')
    target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf8')
    print(json.dumps({k: report[k] for k in ['buildId', 'fpkBytes', 'deltaFromBaselineBytes', 'sizePass']}))
    if not report['sizePass'] and not args.report_only:
        raise SystemExit('Complete FPK exceeds the exclusive size limit; not a completed slimming delivery.')


if __name__ == '__main__':
    main()
