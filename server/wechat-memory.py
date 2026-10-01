"""Bounded, read-only allocation map; never touch unmapped anonymous pages."""
import os
import struct

PAGE = os.sysconf('SC_PAGE_SIZE') if hasattr(os, 'sysconf') else 4096


def allocated_segments(fd, address, size):
    """Keep present and swapped allocations, clipped to the requested interval.

    A live object can be swapped out, so omitting swapped pages would lose
    functionality. Untouched anonymous pages have neither bit: reading them
    through /proc/PID/mem needlessly faults zero pages into WeChat. Unavailable
    pagemap falls back to the existing bounded scan, without requiring root.
    """
    if fd is None:
        return [(address, size)]
    first = address // PAGE
    count = (address + size - 1) // PAGE - first + 1
    try:
        raw = os.pread(fd, count * 8, first * 8)
    except OSError:
        return [(address, size)]
    if len(raw) != count * 8:
        return [(address, size)]
    segments, begin = [], None
    for index, (entry,) in enumerate(struct.iter_unpack('<Q', raw)):
        if entry & ((1 << 63) | (1 << 62)):
            if begin is None:
                begin = max(address, (first + index) * PAGE)
        elif begin is not None:
            stop = min(address + size, (first + index) * PAGE)
            segments.append((begin, stop - begin))
            begin = None
    if begin is not None:
        segments.append((begin, address + size - begin))
    return segments
