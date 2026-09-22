"""Run under dbus-run-session on Linux; uses synthetic files, never a chat."""
import ctypes as c
import json
import os
import pathlib
import select
import subprocess
import sys
import tempfile
import time


def main():
    if sys.platform != 'linux' or not os.environ.get('DBUS_SESSION_BUS_ADDRESS'):
        raise RuntimeError('Run under an isolated dbus-run-session on Linux')
    gio, glib = c.CDLL('libgio-2.0.so.0'), c.CDLL('libglib-2.0.so.0')
    ptr, string = c.c_void_p, c.c_char_p

    def api(lib, name, result, args):
        fn = getattr(lib, name)
        fn.restype, fn.argtypes = result, args
        return fn

    connection = api(gio, 'g_bus_get_sync', ptr, [c.c_int, ptr, ptr])(2, None, None)
    parse = api(glib, 'g_variant_parse', ptr, [ptr, string, ptr, ptr, ptr])
    unref = api(glib, 'g_variant_unref', None, [ptr])
    child = api(glib, 'g_variant_get_child_value', ptr, [ptr, c.c_size_t])
    get_string = api(glib, 'g_variant_get_string', string, [ptr, ptr])
    call_sync = api(gio, 'g_dbus_connection_call_sync', ptr, [ptr, string, string, string, string, ptr, ptr, c.c_int, c.c_int, ptr, ptr])
    responses = []
    callback_type = c.CFUNCTYPE(None, *([ptr] * 7))

    @callback_type
    def signal(_connection, _sender, object_path, _interface, _name, parameters, _data):
        response = child(parameters, 0)
        value = api(glib, 'g_variant_get_uint32', c.c_uint, [ptr])(response)
        unref(response)
        payload = child(parameters, 1)
        uris = api(glib, 'g_variant_lookup_value', ptr, [ptr, string, ptr])(payload, b'uris', None)
        items = []
        if uris:
            count = api(glib, 'g_variant_n_children', c.c_size_t, [ptr])(uris)
            for index in range(count):
                item = child(uris, index)
                items.append(get_string(item, None).decode())
                unref(item)
            unref(uris)
        unref(payload)
        responses.append({'path': c.string_at(object_path).decode(), 'response': value, 'uris': items})

    api(gio, 'g_dbus_connection_signal_subscribe', c.c_uint, [ptr, string, string, string, string, string, c.c_int, callback_type, ptr, ptr])(connection, b'org.freedesktop.portal.Desktop', b'org.freedesktop.portal.Request', b'Response', None, None, 0, signal, None, None)
    iteration = api(glib, 'g_main_context_iteration', c.c_int, [ptr, c.c_int])

    def call(interface, name, args, object_path='/org/freedesktop/portal/desktop'):
        params = parse(None, args.encode(), None, None, None)
        assert params
        error = ptr()
        value = call_sync(connection, b'org.freedesktop.portal.Desktop', object_path.encode(), interface.encode(), name.encode(), params, None, 0, 5000, None, c.byref(error))
        assert value and not error.value, f'{interface}.{name} failed'
        return value

    portal_env = {**os.environ, 'DISPLAY': os.environ.get('QIBOX_PORTAL_TEST_DISPLAY', '')}
    process = subprocess.Popen([sys.executable, sys.argv[1]], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=portal_env)

    def event():
        assert select.select([process.stdout], [], [], 6)[0], 'Portal event timed out'
        line = process.stdout.readline()
        assert line, f'Portal exited: {process.poll()}'
        return json.loads(line)

    def request(token):
        value = call('org.freedesktop.portal.FileChooser', 'OpenFile', f"('', '选择文件', {{'handle_token': <'{token}'>, 'multiple': <true>}})")
        member = child(value, 0)
        handle = get_string(member, None).decode()
        unref(member); unref(value)
        received = event()
        assert received['type'] == 'request' and received['multiple'] is True
        assert handle.endswith('/' + token)
        return handle, received['id']

    try:
        assert event() == {'type': 'ready'}
        value = call('org.freedesktop.DBus.Properties', 'Get', "('org.freedesktop.portal.FileChooser', 'version')")
        unref(value)
        with tempfile.TemporaryDirectory(prefix='qibox-portal-test-') as temporary:
            file = pathlib.Path(temporary) / '资料 #1.txt'
            file.write_bytes(b'isolated portal contract test')
            handle, request_id = request('qibox_test_open')
            process.stdin.write(json.dumps({'id': request_id, 'response': 0, 'uris': [file.as_uri()]}) + '\n'); process.stdin.flush()
            until = time.monotonic() + 5
            while not responses and time.monotonic() < until:
                iteration(None, False); time.sleep(.01)
            assert responses == [{'path': handle, 'response': 0, 'uris': [file.as_uri()]}], responses
            handle, request_id = request('qibox_test_cancel')
            process.stdin.write(json.dumps({'id': request_id, 'response': 1}) + '\n'); process.stdin.flush()
            until = time.monotonic() + 5
            while len(responses) < 2 and time.monotonic() < until:
                iteration(None, False); time.sleep(.01)
            assert responses[-1] == {'path': handle, 'response': 1, 'uris': []}
            handle, request_id = request('qibox_test_close')
            value = call('org.freedesktop.portal.Request', 'Close', '()', handle)
            unref(value)
            assert event() == {'type': 'cancelled', 'id': request_id}
            for name, options in [('SaveFile', "'current_name': <'测试.txt'>"), ('OpenFile', "'directory': <true>")]:
                value = call('org.freedesktop.portal.FileChooser', name, "('', 'Isolated chooser test', {" + options + '})')
                member = child(value, 0)
                handle = get_string(member, None).decode()
                unref(member); unref(value)
                if portal_env['DISPLAY']:
                    # Let GTK create the dialog, then cancel through the public
                    # Request.Close contract on a separate test-only X display.
                    time.sleep(.25)
                    value = call('org.freedesktop.portal.Request', 'Close', '()', handle)
                    unref(value)
                    assert event()['type'] == 'cancelled'
                else:
                    expected = len(responses) + 1
                    until = time.monotonic() + 5
                    while len(responses) < expected and time.monotonic() < until:
                        iteration(None, False); time.sleep(.01)
                    assert responses[-1] == {'path': handle, 'response': 2, 'uris': []}
            # A cancelled/failed desktop dialog must not stop the portal.
            handle, request_id = request('qibox_test_after_desktop')
            value = call('org.freedesktop.portal.Request', 'Close', '()', handle)
            unref(value)
            assert event() == {'type': 'cancelled', 'id': request_id}
        print(json.dumps({'status': 'passed', 'checks': ['Private portal registration and version', 'Native OpenFile request and matching handle', 'Exact uploaded file URI in Response', 'Browser cancellation', 'Native Request.Close cancellation', 'Save/folder Request.Close' if portal_env['DISPLAY'] else 'Save/folder failure without display', 'OpenFile works after desktop dialog'], 'note': 'Isolated D-Bus contract test; no WeChat messages or user data touched.'}))
    finally:
        process.terminate()
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.kill(); process.wait()
        errors = process.stderr.read()
        if errors: print(errors, file=sys.stderr)


if __name__ == '__main__':
    main()
