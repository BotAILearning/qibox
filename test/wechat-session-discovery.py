"""Anchor discovery with a synthetic process image.

The NAS test needs a signed-in WeChat; this one does not. It lays out a fake
heap holding one real-looking manager plus a decoy copy of the anchor literal,
then checks that _discover() finds exactly the manager and nothing else.

Run: python test/wechat-session-discovery.py
"""
import importlib.util
import pathlib
import struct
import sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent


def load_module():
    spec = importlib.util.spec_from_file_location(
        'qibox_wechat_session', ROOT / 'server' / 'wechat-session.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


EXE = '/opt/wechat/wechat'
EXE_BASE = 0x560d00000000
VTABLE_RVA = 0xa66d808
HEAP = 0x7f0000000000
MANAGER_OFFSET = 0x1000          # 8-aligned
MANAGER_KEY = 0x178
DECOY = 0x5000
HEAP_SIZE = 0x10000

failures = []


def check(name, condition, detail=''):
    print('%s %s%s' % ('PASS' if condition else 'FAIL', name, detail and ' - ' + detail))
    if not condition:
        failures.append(name)


def build():
    heap = bytearray(HEAP_SIZE)
    manager = HEAP + MANAGER_OFFSET
    struct.pack_into('<Q', heap, MANAGER_OFFSET, EXE_BASE + VTABLE_RVA)
    # libc++ short string at manager_key: length byte first, bytes from +1
    anchor_slot = MANAGER_OFFSET + MANAGER_KEY
    heap[anchor_slot] = len(b'normal_key') << 1
    heap[anchor_slot + 1:anchor_slot + 11] = b'normal_key\0'
    # A decoy literal that belongs to no manager at all.
    heap[DECOY:DECOY + 10] = b'normal_key'
    return manager, bytes(heap)


def real_segments():
    """The segment layout actually observed on the NAS.

    These RVAs come from a live 4.1.13.9 process. The vtable lives at
    +0xa66d808, which is inside the read-only r--p image segment - not the
    executable r-xp one. A discovery check that demands an executable mapping
    rejects every real candidate, so this layout guards that regression.
    """
    return [
        (EXE_BASE, EXE_BASE + 0x4DA000, 'r--p', 0, EXE),
        (EXE_BASE + 0x4DA000, EXE_BASE + 0xA638000, 'r-xp', 0, EXE),
        (EXE_BASE + 0xA638000, EXE_BASE + 0xAB8E000, 'r--p', 0, EXE),
        (EXE_BASE + 0xAB8E000, EXE_BASE + 0xB000000, 'rw-p', 0, EXE),
        (HEAP, HEAP + HEAP_SIZE, 'rw-p', 0, '[heap]'),
    ]


def make_session(module, heap_bytes, segments=None):
    identity = module.SessionIdentity.__new__(module.SessionIdentity)
    identity.check = lambda: None
    identity.bound = (12345, EXE, None, None)
    identity.base = EXE_BASE
    identity.fd = None
    identity.profile = None
    identity.manager = None
    # Roomy enough to hold the vtable RVA: it sits ~174 MB into a ~231 MB binary.
    identity.maps = segments or [
        (EXE_BASE, EXE_BASE + 0x10000000, 'r-xp', 0, EXE),
        (HEAP, HEAP + HEAP_SIZE, 'rw-p', 0, '[heap]'),
    ]

    def read(address, length):
        if HEAP <= address and address + length <= HEAP + HEAP_SIZE:
            return heap_bytes[address - HEAP:address - HEAP + length]
        raise ValueError('session memory unavailable')

    identity._read = read
    identity.probed = []

    def selection(manager, profile=None):
        identity.probed.append((manager, profile))
        # Stand-in for the live structure checks: only the real manager survives.
        if manager != HEAP + MANAGER_OFFSET:
            raise ValueError('session vector unavailable')
        return 'selected'

    identity._selection = selection
    return identity


def main():
    module = load_module()
    manager, heap_bytes = build()
    check('anchor found in binary image before use', module.ANCHOR == b'normal_key')

    identity = make_session(module, heap_bytes)
    found = identity._discover()
    check('discovers the manager', found == manager, 'got %s' % hex(found))
    check('read vtable back out of it', identity.profile.get('manager_vtable') == VTABLE_RVA,
          'got %s' % hex(identity.profile.get('manager_vtable', -1)))
    check('kept the assumed member offsets', identity.profile.get('manager_key') == MANAGER_KEY)
    check('decoy rejected once, not selected', len(identity.probed) == 1,
          '%d probes' % len(identity.probed))
    check('known layout stays independent of any one build', 'sha256' not in identity.profile)

    # Same layout as the live process, where the vtable sits in a read-only
    # image segment rather than the executable one.
    real = make_session(module, heap_bytes, real_segments())
    real_found = real._discover()
    check('discovers with the real read-only segment layout', real_found == manager,
          'got %s' % hex(real_found))
    check('real layout reads the same vtable', real.profile.get('manager_vtable') == VTABLE_RVA,
          'got %s' % hex(real.profile.get('manager_vtable', -1)))

    # A second genuine-looking manager must be refused rather than guessed.
    twin = bytearray(heap_bytes)
    second = 0x2000
    struct.pack_into('<Q', twin, second, EXE_BASE + VTABLE_RVA)
    twin[second + MANAGER_KEY] = len(b'normal_key') << 1
    twin[second + MANAGER_KEY + 1:second + MANAGER_KEY + 11] = b'normal_key\0'
    twin[DECOY:DECOY + 10] = b'normal_key'
    ambiguous = make_session(module, bytes(twin))

    def both_selected(manager_arg, profile=None):
        return 'selected'

    ambiguous._selection = both_selected
    try:
        ambiguous._discover()
        check('two candidates refused', False, 'no error raised')
    except ValueError as error:
        check('two candidates refused', 'ambiguous' in str(error), str(error))

    print('\n%d failure(s)' % len(failures))
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())
