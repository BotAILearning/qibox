"""Read-only hit testing for this WeChat's Moments and article windows.

This never authorizes an AI send or clears an unresolved chat draft.
"""
import ctypes as c
import pathlib


def webview_identity(pid, owner, proc=pathlib.Path('/proc')):
    if type(pid) is not int or type(owner) is not int or min(pid, owner) <= 0 or pid == owner:
        return None
    try:
        main, child = proc / str(pid), proc / str(owner)
        status = (child / 'status').read_text()
        parent = next(int(line.split(':', 1)[1]) for line in status.splitlines() if line.startswith('PPid:'))
        # WeChatAppEx is non-dumpable: its /proc/exe is unreadable even to the
        # owning service UID. Use only argv[0], together with direct parentage,
        # UID and process start times; never inspect or log the remaining args.
        def argv0(process):
            with (process / 'cmdline').open('rb') as stream:
                return stream.read(16384).split(b'\0', 1)[0].decode('utf-8', errors='strict')
        main_command = pathlib.Path(argv0(main))
        if not main_command.is_absolute():
            return None
        executable = (main_command.resolve(strict=True).parent / 'RadiumWMPF/runtime/WeChatAppEx').resolve(strict=True)
        child_command = argv0(child)
        # Official WeChatAppEx rewrites argv[0] to include its launch options.
        if child_command != str(executable) and not child_command.startswith(str(executable) + ' --'):
            return None
        if (parent != pid or (child / 'comm').read_text().strip() != 'WeChatAppEx'
                or child.stat().st_uid != main.stat().st_uid):
            return None
        # /proc/stat fields after comm begin at field 3; starttime is field 22.
        starts = tuple((process / 'stat').read_text().rsplit(')', 1)[1].split()[19] for process in (main, child))
        return owner, executable, starts
    except (OSError, StopIteration, ValueError, IndexError):
        return None


def manual_webview_pointer(pid, event, windows, check):
    if (type(pid) is not int or pid <= 0 or event.get('type') != 'pointer'
            or any(type(event.get(k)) is not int or not 0 <= event[k] <= 65535 for k in ('x', 'y'))):
        return False
    try:
        check()
        with windows.x11_connection() as (x, display, errors):
            root = x.XDefaultRootWindow(display)
            atoms = {name: x.XInternAtom(display, name.encode(), 1)
                     for name in ('_NET_ACTIVE_WINDOW', '_NET_WM_PID', 'WINDOW', 'CARDINAL')}
            if not root or not all(atoms.values()) or errors:
                return False
            active = windows.x11_property32(x, display, root, atoms['_NET_ACTIVE_WINDOW'], atoms['WINDOW'])
            owner = windows.x11_property32(x, display, active, atoms['_NET_WM_PID'], atoms['CARDINAL'])
            def identity_for_window():
                if owner != pid:
                    return webview_identity(pid, owner)
                # Moments is a separate NORMAL window of the chat process.
                # It cannot submit the AI's chat draft. Authenticate its exact
                # title/class; other same-PID windows still use the chat guard.
                if windows.x11_window_title(x, display, active) != '朋友圈':
                    return None
                prop = x.XInternAtom(display, b'WM_CLASS', 1)
                kind = x.XInternAtom(display, b'STRING', 1)
                if not prop or not kind or windows.x11_property_array(
                        x, display, active, prop, kind, 8) != b'wechat\0wechat\0':
                    return None
                return ('moments', pid)
            identity = identity_for_window()
            if identity is None:
                return False
            attrs = windows.XWindowAttributes()
            if not x.XGetWindowAttributes(display, active, c.byref(attrs)) or attrs.map_state != 2:
                return False
            x.XTranslateCoordinates.restype = c.c_int
            x.XTranslateCoordinates.argtypes = [c.c_void_p, c.c_ulong, c.c_ulong, c.c_int, c.c_int,
                                               c.POINTER(c.c_int), c.POINTER(c.c_int), c.POINTER(c.c_ulong)]
            x.XQueryTree.restype = c.c_int
            x.XQueryTree.argtypes = [c.c_void_p, c.c_ulong, c.POINTER(c.c_ulong), c.POINTER(c.c_ulong),
                                    c.POINTER(c.POINTER(c.c_ulong)), c.POINTER(c.c_uint)]
            lx, ly, hit = c.c_int(), c.c_int(), c.c_ulong()
            if (not x.XTranslateCoordinates(display, root, active, event['x'], event['y'], c.byref(lx), c.byref(ly), c.byref(hit))
                    or not (0 <= lx.value < attrs.width and 0 <= ly.value < attrs.height)):
                return False
            if not x.XTranslateCoordinates(display, root, root, event['x'], event['y'], c.byref(lx), c.byref(ly), c.byref(hit)):
                return False
            # Match the actual topmost hit window, including Openbox's frame.
            frame = active
            for _ in range(8):
                tree_root, parent, count = c.c_ulong(), c.c_ulong(), c.c_uint()
                children = c.POINTER(c.c_ulong)()
                try:
                    ok = x.XQueryTree(display, frame, c.byref(tree_root), c.byref(parent), c.byref(children), c.byref(count))
                finally:
                    if children:
                        x.XFree(c.cast(children, c.c_void_p))
                if not ok or not parent.value:
                    return False
                if parent.value == root:
                    break
                frame = parent.value
            else:
                return False
            if hit.value != frame:
                # An article menu may be an override-redirect root window.
                hit_owner = windows.x11_property32(x, display, hit.value, atoms['_NET_WM_PID'], atoms['CARDINAL'])
                if hit_owner != owner:
                    return False
            check()
            after = windows.x11_property32(x, display, root, atoms['_NET_ACTIVE_WINDOW'], atoms['WINDOW'])
            after_owner = windows.x11_property32(x, display, active, atoms['_NET_WM_PID'], atoms['CARDINAL'])
            if errors or after != active or after_owner != owner or identity_for_window() != identity:
                return False
            return True
    except (windows.ControlsUnavailable, OSError, AttributeError, ValueError):
        return False
