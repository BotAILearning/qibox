"""FileChooser portal on one instance's private D-Bus session.

Open-file requests are forwarded to the connected browser. Selected paths only
come back from the parent service after upload. This helper never sends a chat.
Save, copied files and containing folders are forwarded to the same browser.
"""
import ctypes as c
import json
import os
import re
import signal
import sys
import time
import uuid
import struct
import pathlib
from clipboard_payload import LOCAL_TARGET


def main():
    # This helper uses GTK only for clipboard/folder services. It must not wait
    # for WeChat's accessibility registry during portal startup.
    os.environ['NO_AT_BRIDGE'] = '1'
    gio, glib = c.CDLL('libgio-2.0.so.0'), c.CDLL('libglib-2.0.so.0')

    def api(lib, name, result, args):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = result, args
        return fn

    ptr, string = c.c_void_p, c.c_char_p
    child = api(glib, 'g_variant_get_child_value', ptr, [ptr, c.c_size_t])
    get_string = api(glib, 'g_variant_get_string', string, [ptr, ptr])
    unref = api(glib, 'g_variant_unref', None, [ptr])
    lookup = api(glib, 'g_variant_lookup_value', ptr, [ptr, string, ptr])
    new_string = api(glib, 'g_variant_new_string', ptr, [string])
    new_uint = api(glib, 'g_variant_new_uint32', ptr, [c.c_uint])
    new_path = api(glib, 'g_variant_new_object_path', ptr, [string])
    new_tuple = api(glib, 'g_variant_new_tuple', ptr, [c.POINTER(ptr), c.c_size_t])
    variant_type = api(glib, 'g_variant_type_new', ptr, [string])
    type_dict = variant_type(b'a{sv}')
    builder_new = api(glib, 'g_variant_builder_new', ptr, [ptr])
    builder_add = api(glib, 'g_variant_builder_add_value', None, [ptr, ptr])
    builder_end = api(glib, 'g_variant_builder_end', ptr, [ptr])
    builder_unref = api(glib, 'g_variant_builder_unref', None, [ptr])
    new_variant = api(glib, 'g_variant_new_variant', ptr, [ptr])
    new_entry = api(glib, 'g_variant_new_dict_entry', ptr, [ptr, ptr])
    new_strv = api(glib, 'g_variant_new_strv', ptr, [c.POINTER(string), c.c_ssize_t])
    get_boolean = api(glib, 'g_variant_get_boolean', c.c_int, [ptr])
    get_uint = api(glib, 'g_variant_get_uint32', c.c_uint, [ptr])
    child_count = api(glib, 'g_variant_n_children', c.c_size_t, [ptr])
    is_type = api(glib, 'g_variant_is_of_type', c.c_int, [ptr, ptr])
    type_string, type_boolean = variant_type(b's'), variant_type(b'b')

    def option(options, key, default=None):
        value = lookup(options, key.encode(), None)
        if not value:
            return default
        try:
            if is_type(value, type_string): return get_string(value, None).decode('utf-8')
            if is_type(value, type_boolean): return bool(get_boolean(value))
            return default
        finally:
            unref(value)

    def image_extension(options):
        mime = {'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif', 'image/bmp': 'bmp'}
        for key in ('current_filter', 'filters'):
            value = lookup(options, key.encode(), None)
            if not value:
                continue
            try:
                for i in range(1 if key == 'current_filter' else child_count(value)):
                    selected = value if key == 'current_filter' else child(value, i)
                    try:
                        rules = child(selected, 1)
                        try:
                            for j in range(child_count(rules)):
                                rule = child(rules, j)
                                try:
                                    kind, pattern = child(rule, 0), child(rule, 1)
                                    try:
                                        text = get_string(pattern, None).decode('utf-8').lower()
                                        suffix = mime.get(text) if get_uint(kind) == 1 else None
                                        if not suffix:
                                            match = re.fullmatch(r'\*\.(jpe?g|png|webp|gif|bmp)', text)
                                            suffix = 'jpg' if match and match[1] == 'jpeg' else match[1] if match else None
                                        if suffix: return suffix
                                    finally:
                                        unref(kind); unref(pattern)
                                finally:
                                    unref(rule)
                        finally:
                            unref(rules)
                    finally:
                        if selected != value: unref(selected)
            finally:
                unref(value)
        return 'png'

    def tuple_value(*values):
        return new_tuple((ptr * len(values))(*values), len(values))

    def results(uris):
        builder = builder_new(type_dict)
        if uris:
            encoded = [uri.encode('utf-8') for uri in uris]
            array = new_strv((string * len(encoded))(*encoded), len(encoded))
            builder_add(builder, new_entry(new_string(b'uris'), new_variant(array)))
        result = builder_end(builder)
        builder_unref(builder)
        return result

    xml = b'''<node>
    <interface name="org.freedesktop.FileManager1">
      <method name="ShowItems"><arg type="as" direction="in"/><arg type="s" direction="in"/></method>
      <method name="ShowFolders"><arg type="as" direction="in"/><arg type="s" direction="in"/></method>
    </interface>
    <interface name="org.freedesktop.portal.FileChooser">
      <property name="version" type="u" access="read"/>
      <method name="OpenFile"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
      <method name="SaveFile"><arg type="s" direction="in"/><arg type="s" direction="in"/><arg type="a{sv}" direction="in"/><arg type="o" direction="out"/></method>
    </interface>
    <interface name="org.freedesktop.portal.Request">
      <method name="Close"/>
      <signal name="Response"><arg type="u"/><arg type="a{sv}"/></signal>
    </interface>
    </node>'''
    connection = api(gio, 'g_bus_get_sync', ptr, [c.c_int, ptr, ptr])(2, None, None)
    info = api(gio, 'g_dbus_node_info_new_for_xml', ptr, [string, ptr])(xml, None)
    if not connection or not info:
        raise RuntimeError('Private bus unavailable')
    get_interface = api(gio, 'g_dbus_node_info_lookup_interface', ptr, [ptr, string])
    register = api(gio, 'g_dbus_connection_register_object', c.c_uint, [ptr, string, ptr, ptr, ptr, ptr, ptr])
    unregister = api(gio, 'g_dbus_connection_unregister_object', c.c_int, [ptr, c.c_uint])
    return_value = api(gio, 'g_dbus_method_invocation_return_value', None, [ptr, ptr])
    return_error = api(gio, 'g_dbus_method_invocation_return_dbus_error', None, [ptr, string, string])
    emit = api(gio, 'g_dbus_connection_emit_signal', c.c_int, [ptr, string, string, string, string, ptr, ptr])
    requests = {}
    libc = c.CDLL(None, use_errno=True)
    watch_fd = api(libc, 'inotify_init1', c.c_int, [c.c_int])(os.O_NONBLOCK | os.O_CLOEXEC)
    if watch_fd < 0: raise RuntimeError('File completion watcher unavailable')
    add_watch = api(libc, 'inotify_add_watch', c.c_int, [c.c_int, string, c.c_uint])
    remove_watch = api(libc, 'inotify_rm_watch', c.c_int, [c.c_int, c.c_int])
    watches = {}

    def forget_watch(request_id):
        for wd, item in list(watches.items()):
            if item['id'] == request_id:
                remove_watch(watch_fd, wd)
                watches.pop(wd, None)

    def watch_save(request_id, filename):
        if request_id not in requests or not isinstance(filename, str) or not os.path.isabs(filename):
            raise ValueError('Invalid save request')
        wd = add_watch(watch_fd, os.fsencode(os.path.dirname(filename)), 8 | 128)
        if wd < 0: raise RuntimeError('File completion watcher unavailable')
        watches[wd] = {'id': request_id, 'name': os.fsencode(os.path.basename(filename)), 'created': time.monotonic()}
    method_type = c.CFUNCTYPE(None, *([ptr] * 8))
    property_type = c.CFUNCTYPE(ptr, *([ptr] * 7))

    def reply(request_id, response, uris=None):
        request = requests.pop(request_id, None)
        if not request:
            return
        if request.get('dismiss'):
            request['dismiss']()
        emit(connection, request['sender'], request['path'], b'org.freedesktop.portal.Request', b'Response', tuple_value(new_uint(response), results(uris or [])), None)
        unregister(connection, request['registration'])

    def native_dialog(request_id, title, options, save, directory):
        # Use GtkFileChooserDialog directly: GtkFileChooserNative could recurse
        # into this portal. This branch never participates in browser uploads.
        gtk = c.CDLL('libgtk-3.so.0')
        if not api(gtk, 'gtk_init_check', c.c_int, [ptr, ptr])(None, None):
            raise RuntimeError('Desktop unavailable')
        create = api(gtk, 'gtk_file_chooser_dialog_new', ptr, [string, ptr, c.c_int, string, c.c_int, string, c.c_int, ptr])
        dialog = create(title.encode(), None, 2 if directory else 1 if save else 0, '取消'.encode(), -6, ('保存' if save else '选择').encode(), -3, None)
        if not dialog:
            raise RuntimeError('Dialog unavailable')
        requests[request_id]['dismiss'] = lambda: api(gtk, 'gtk_dialog_response', None, [ptr, c.c_int])(dialog, -6)
        if save:
            api(gtk, 'gtk_file_chooser_set_do_overwrite_confirmation', None, [ptr, c.c_int])(dialog, 1)
            name = option(options, 'current_name', '')
            if name: api(gtk, 'gtk_file_chooser_set_current_name', None, [ptr, string])(dialog, name.encode())
        response = api(gtk, 'gtk_dialog_run', c.c_int, [ptr])(dialog)
        uris = []
        if response == -3:
            value = api(gtk, 'gtk_file_chooser_get_uri', ptr, [ptr])(dialog)
            if value:
                uris = [c.string_at(value).decode('utf-8')]
                api(glib, 'g_free', None, [ptr])(value)
        api(gtk, 'gtk_widget_destroy', None, [ptr])(dialog)
        if request_id in requests:
            requests[request_id].pop('dismiss', None)
        reply(request_id, 0 if uris else 1, uris)

    @method_type
    def method(_connection, sender_ptr, object_ptr, interface_ptr, method_ptr, parameters, invocation, _data):
        returned, request_id = False, None
        try:
            method_name = c.string_at(method_ptr)
            sender, object_path = c.string_at(sender_ptr), c.string_at(object_ptr)
            if method_name in (b'ShowItems', b'ShowFolders'):
                array = child(parameters, 0)
                try:
                    count = api(glib, 'g_variant_n_children', c.c_size_t, [ptr])(array)
                    if count != 1: raise ValueError('Select one folder')
                    value = child(array, 0)
                    try: uri = get_string(value, None).decode('utf-8')
                    finally: unref(value)
                    if not uri.startswith('file:///') or '\0' in uri: raise ValueError('Invalid file')
                    print(json.dumps({'type': 'request', 'id': str(uuid.uuid4()), 'operation': 'folder', 'uris': [uri]}), flush=True)
                finally: unref(array)
                return_value(invocation, None)
                return
            if method_name == b'Close':
                target = next((key for key, item in requests.items() if item['sender'] == sender and item['path'] == object_path), None)
                return_value(invocation, None)
                returned = True
                if target:
                    request = requests.pop(target)
                    if request.get('dismiss'):
                        request['dismiss']()
                    unregister(connection, request['registration'])
                    print(json.dumps({'type': 'cancelled', 'id': target}), flush=True)
                return
            if method_name not in (b'OpenFile', b'SaveFile'):
                return_error(invocation, b'org.freedesktop.DBus.Error.UnknownMethod', b'Unsupported file operation')
                return
            title_value, options = child(parameters, 1), child(parameters, 2)
            try:
                title = get_string(title_value, None).decode('utf-8')
                token = option(options, 'handle_token', '')
                if not isinstance(token, str) or not re.fullmatch(r'[A-Za-z0-9_]{1,128}', token): token = 'qibox_' + uuid.uuid4().hex
                handle = b'/org/freedesktop/portal/desktop/request/' + sender.lstrip(b':').replace(b'.', b'_') + b'/' + token.encode()
                request_id = str(uuid.uuid4())
                registration = register(connection, handle, get_interface(info, b'org.freedesktop.portal.Request'), c.byref(table), None, None, None)
                if not registration: raise RuntimeError('Request already exists')
                requests[request_id] = {'sender': sender, 'path': handle, 'registration': registration, 'created': time.monotonic()}
                return_value(invocation, tuple_value(new_path(handle)))
                returned = True
                if method_name == b'SaveFile':
                    # The image viewer omits current_name; provide an extension
                    # so the native image writer can select an output format.
                    name = option(options, 'current_name', '') or '微信图片.' + image_extension(options)
                    print(json.dumps({'type': 'request', 'id': request_id, 'operation': 'save', 'name': name}), flush=True)
                elif option(options, 'directory', False):
                    native_dialog(request_id, title, options, False, True)
                else:
                    print(json.dumps({'type': 'request', 'id': request_id, 'multiple': bool(option(options, 'multiple', False))}), flush=True)
            finally:
                unref(title_value)
                unref(options)
        except Exception:
            # Never emit paths, chat labels or option strings into logs.
            if returned:
                if request_id: reply(request_id, 2)
            else:
                return_error(invocation, b'org.freedesktop.portal.Error.Failed', b'File chooser unavailable')

    @property_type
    def get_property(*_args):
        return new_uint(3)

    class VTable(c.Structure):
        _fields_ = [('method', method_type), ('get_property', property_type), ('set_property', ptr), ('padding', ptr * 8)]

    table = VTable(method, get_property, None)
    if not register(connection, b'/org/freedesktop/portal/desktop', get_interface(info, b'org.freedesktop.portal.FileChooser'), c.byref(table), None, None, None):
        raise RuntimeError('Portal registration failed')
    if not register(connection, b'/org/freedesktop/FileManager1', get_interface(info, b'org.freedesktop.FileManager1'), c.byref(table), None, None, None):
        raise RuntimeError('File manager registration failed')
    name_type = c.CFUNCTYPE(None, ptr, string, ptr)
    loop = api(glib, 'g_main_loop_new', ptr, [ptr, c.c_int])(None, 0)
    quit_loop = api(glib, 'g_main_loop_quit', None, [ptr])

    @name_type
    def acquired(*_args):
        print('{"type":"ready"}', flush=True)

    @name_type
    def lost(*_args):
        quit_loop(loop)

    api(gio, 'g_bus_own_name_on_connection', c.c_uint, [ptr, string, c.c_int, name_type, name_type, ptr, ptr])(connection, b'org.freedesktop.portal.Desktop', 0, acquired, lost, None, None)
    @name_type
    def manager_acquired(*_args): pass
    api(gio, 'g_bus_own_name_on_connection', c.c_uint, [ptr, string, c.c_int, name_type, name_type, ptr, ptr])(connection, b'org.freedesktop.FileManager1', 0, manager_acquired, lost, None, None)
    gtk, gdk, gobject = c.CDLL('libgtk-3.so.0'), c.CDLL('libgdk-3.so.0'), c.CDLL('libgobject-2.0.so.0')
    if not api(gtk, 'gtk_init_check', c.c_int, [ptr, ptr])(None, None): raise RuntimeError('Clipboard unavailable')
    atom = api(gdk, 'gdk_atom_intern', ptr, [string, c.c_int])
    clipboard = api(gtk, 'gtk_clipboard_get', ptr, [ptr])(atom(b'CLIPBOARD', 0))
    clipboard_dirty = [False]
    owner_type = c.CFUNCTYPE(None, ptr, ptr, ptr)
    @owner_type
    def owner_changed(*_args): clipboard_dirty[0] = True
    api(gobject, 'g_signal_connect_data', c.c_ulong, [ptr, string, owner_type, ptr, ptr, c.c_int])(clipboard, b'owner-change', owner_changed, None, None, 0)

    clipboard_root = pathlib.Path(os.environ.get('QIBOX_CLIPBOARD_ROOT', os.environ.get('TMPDIR', '/tmp') + '/qibox-clipboard-snapshots'))
    clipboard_root.mkdir(mode=0o700, parents=True, exist_ok=True)
    snapshots = {}

    def clipboard_contents(target, limit):
        selection = api(gtk, 'gtk_clipboard_wait_for_contents', ptr, [ptr, ptr])(clipboard, atom(target, 0))
        if not selection: return None
        try:
            size = api(gtk, 'gtk_selection_data_get_length', c.c_int, [ptr])(selection)
            if not 0 < size <= limit: return None
            data = api(gtk, 'gtk_selection_data_get_data', ptr, [ptr])(selection)
            return c.string_at(data, size) if data else None
        finally:
            api(gtk, 'gtk_selection_data_free', None, [ptr])(selection)

    def copied_clipboard():
        targets, count = c.POINTER(ptr)(), c.c_int()
        if not api(gtk, 'gtk_clipboard_wait_for_targets', c.c_int, [ptr, c.POINTER(c.POINTER(ptr)), c.POINTER(c.c_int)])(clipboard, c.byref(targets), c.byref(count)):
            print('{"type":"clipboard-clear"}', flush=True)
            return
        try:
            available = {targets[i] for i in range(min(count.value, 256))}
        finally:
            api(glib, 'g_free', None, [ptr])(targets)
        # Native IME commits and local paste are already known to the browser.
        # Never echo them back and overwrite the user's own system clipboard.
        if atom(LOCAL_TARGET, 0) in available:
            print('{"type":"clipboard-clear"}', flush=True)
            return
        for target in (b'text/uri-list', b'x-special/gnome-copied-files'):
            if atom(target, 0) not in available: continue
            data = clipboard_contents(target, 65536)
            if not data: continue
            uris = [line for line in data.decode('utf-8').splitlines() if line.startswith('file:///') and '\0' not in line]
            if 0 < len(uris) <= 20:
                print(json.dumps({'type': 'request', 'id': str(uuid.uuid4()), 'operation': 'copy', 'uris': uris}), flush=True)
                return
        if atom(b'image/png', 0) in available:
            pixbuf = api(gtk, 'gtk_clipboard_wait_for_image', ptr, [ptr])(clipboard)
            if pixbuf:
                pix = c.CDLL('libgdk_pixbuf-2.0.so.0')
                try:
                    width = api(pix, 'gdk_pixbuf_get_width', c.c_int, [ptr])(pixbuf)
                    height = api(pix, 'gdk_pixbuf_get_height', c.c_int, [ptr])(pixbuf)
                    if not 0 < width * height <= 24000000: return
                    request_id = str(uuid.uuid4())
                    destination = clipboard_root / (request_id + '.png')
                    if api(pix, 'gdk_pixbuf_savev', c.c_int, [ptr, string, string, ptr, ptr, ptr])(pixbuf, os.fsencode(destination), b'png', None, None, None):
                        if destination.stat().st_size > 20 * 1024 * 1024:
                            destination.unlink(missing_ok=True); return
                        destination.chmod(0o600)
                        snapshots[destination] = time.monotonic()
                        print(json.dumps({'type': 'request', 'id': request_id, 'operation': 'copy', 'clipboardType': 'image', 'snapshot': True, 'name': '微信图片.png', 'uris': [destination.as_uri()]}), flush=True)
                        return
                finally:
                    api(gobject, 'g_object_unref', None, [ptr])(pixbuf)
        for target in (b'UTF8_STRING', b'text/plain;charset=utf-8', b'text/plain', b'STRING'):
            if atom(target, 0) not in available: continue
            data = clipboard_contents(target, 60001)
            if not data: continue
            text = data.rstrip(b'\0').decode('latin-1' if target == b'STRING' else 'utf-8')
            if text and '\0' not in text and len(text.encode('utf-8')) <= 60000:
                print(json.dumps({'type': 'request', 'id': str(uuid.uuid4()), 'operation': 'copy', 'clipboardType': 'text', 'text': text}, ensure_ascii=False), flush=True)
                return
        print('{"type":"clipboard-clear"}', flush=True)
    os.set_blocking(sys.stdin.fileno(), False)
    buffer = bytearray()
    tick_type = c.CFUNCTYPE(c.c_int, ptr)

    @tick_type
    def tick(_data):
        try:
            try:
                data = os.read(sys.stdin.fileno(), 65536)
                if not data:
                    quit_loop(loop)
                    return 0
                buffer.extend(data)
            except BlockingIOError:
                pass
            if len(buffer) > 65536:
                quit_loop(loop)
                return 0
            while b'\n' in buffer:
                line, _, rest = buffer.partition(b'\n')
                buffer[:] = rest
                value = json.loads(line)
                if value.get('cancelWatch'):
                    forget_watch(value.get('id'))
                    continue
                response, uris = value.get('response'), value.get('uris', [])
                if response not in (0, 1, 2) or not isinstance(uris, list) or len(uris) > 20 or any(not isinstance(uri, str) or not uri.startswith('file:///') or '\0' in uri for uri in uris):
                    continue
                if response == 0 and value.get('watch'):
                    try: watch_save(value.get('id'), value['watch'])
                    except Exception:
                        reply(value.get('id'), 2)
                        print(json.dumps({'type': 'cancelled', 'id': value.get('id')}), flush=True)
                        continue
                reply(value.get('id'), response, uris)
            try: events = os.read(watch_fd, 65536)
            except BlockingIOError: events = b''
            offset = 0
            while offset + 16 <= len(events):
                wd, mask, cookie, size = struct.unpack_from('iIII', events, offset)
                name = events[offset + 16:offset + 16 + size].rstrip(b'\0'); offset += 16 + size
                item = watches.get(wd)
                if item and mask & (8 | 128) and name == item['name']:
                    print(json.dumps({'type': 'saved', 'id': item['id']}), flush=True)
                    forget_watch(item['id'])
            for item in list(watches.values()):
                if time.monotonic() - item['created'] > 30 * 60:
                    print(json.dumps({'type': 'cancelled', 'id': item['id']}), flush=True)
                    forget_watch(item['id'])
            if clipboard_dirty[0]:
                clipboard_dirty[0] = False
                try: copied_clipboard()
                except (ValueError, UnicodeError, OSError): pass
            for file, created in list(snapshots.items()):
                if not file.exists() or time.monotonic() - created > 60:
                    file.unlink(missing_ok=True)
                    del snapshots[file]
            for key, request in list(requests.items()):
                if time.monotonic() - request['created'] > 30 * 60:
                    reply(key, 1)
                    print(json.dumps({'type': 'cancelled', 'id': key}), flush=True)
        except Exception:
            quit_loop(loop)
            return 0
        return 1

    def stop(*_args):
        for key in list(requests): reply(key, 1)
        quit_loop(loop)

    signal.signal(signal.SIGTERM, stop)
    api(glib, 'g_timeout_add', c.c_uint, [c.c_uint, tick_type, ptr])(50, tick, None)
    api(glib, 'g_main_loop_run', None, [ptr])(loop)
    for key in list(requests): reply(key, 1)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error)[:240], file=sys.stderr)
        raise SystemExit(1)
