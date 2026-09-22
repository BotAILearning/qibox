"""Read-only Linux migration sampler. No message bodies, paths, IPs or keys."""
import argparse, datetime, json, os, pathlib, time

def text(file):
    try: return pathlib.Path(file).read_text()
    except (OSError, UnicodeError): return ''

def counters(file):
    result = {}
    for line in text(file).splitlines():
        key, _, value = line.partition(':')
        try: result[key] = int(value.strip().split()[0])
        except (ValueError, IndexError): pass
    return result

def sample(instance=None):
    processes = {}
    for proc in pathlib.Path('/proc').iterdir():
        if not proc.name.isdigit(): continue
        try:
            env = dict(x.split(b'=', 1) for x in (proc/'environ').read_bytes().split(b'\0') if b'=' in x)
            if b'QIBOX_RUNTIME_TAG' not in env: continue
            if instance and pathlib.Path(env.get(b'HOME', b'').decode()).parent.name != instance: continue
            name = text(proc/'comm').strip()
            if name.lower() not in ('wechat', 'wechatappex'): continue
            stat = text(proc/'stat').rsplit(')', 1)[1].split()
            status = counters(proc/'status')
            processes[proc.name] = {'name': name, 'start': int(stat[19]), 'cpuTicks': int(stat[11])+int(stat[12]),
                'rssKiB': status.get('VmRSS', 0), **counters(proc/'io')}
        except (OSError, ValueError, IndexError): continue
    net = {}
    for line in text('/proc/net/dev').splitlines()[2:]:
        name, values = line.split(':', 1); values = list(map(int, values.split()))
        if name.strip() != 'lo': net[name.strip()] = {'rx': values[0], 'tx': values[8], 'rxErrors': values[2], 'rxDrops': values[3], 'txErrors': values[10]}
    disks = {}
    for line in text('/proc/diskstats').splitlines():
        row = line.split()
        if len(row) >= 14 and not row[2].startswith(('loop', 'ram')):
            disks[row[2]] = {'readSectors': int(row[5]), 'writeSectors': int(row[9]), 'ioMs': int(row[12]), 'weightedMs': int(row[13])}
    mem = counters('/proc/meminfo')
    return {'at': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'monotonic': time.monotonic(), 'processes': processes,
        'network': net, 'disks': disks, 'memory': {k: mem.get(k) for k in ['MemAvailable', 'SwapFree', 'Dirty', 'Writeback']},
        'pressure': {k: text('/proc/pressure/'+k).strip() for k in ['cpu', 'memory', 'io']}}

def rates(previous, current):
    elapsed = current['monotonic'] - previous['monotonic']
    pairs = [(previous['processes'][pid], p) for pid, p in current['processes'].items()
             if pid in previous['processes'] and previous['processes'][pid]['start'] == p['start']]
    delta = lambda key: sum(max(0, b.get(key, 0)-a.get(key, 0)) for a, b in pairs)
    return {'seconds': round(elapsed, 3), 'wechatCpuOneCorePercent': round(100*delta('cpuTicks')/os.sysconf('SC_CLK_TCK')/elapsed, 2),
        'wechatReadBytesPerSec': round(delta('read_bytes')/elapsed), 'wechatWriteBytesPerSec': round(delta('write_bytes')/elapsed)}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--duration', type=int, default=60); parser.add_argument('--interval', type=int, default=5)
    parser.add_argument('--phase', choices=['idle', 'transfer', 'import', 'slow', 'unknown'], default='unknown')
    parser.add_argument('--instance'); args = parser.parse_args()
    if not 1 <= args.interval <= 30 or not args.interval <= args.duration <= 1800: parser.error('duration: interval..1800; interval: 1..30')
    previous = sample(args.instance); print(json.dumps({'type': 'baseline', 'phase': args.phase, **previous}), flush=True)
    until = time.monotonic()+args.duration
    while time.monotonic() < until:
        time.sleep(min(args.interval, max(0, until-time.monotonic())))
        current = sample(args.instance)
        print(json.dumps({'type': 'sample', 'phase': args.phase, 'rates': rates(previous, current), **current}), flush=True)
        previous = current

if __name__ == '__main__': main()
