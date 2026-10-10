import json, socket, struct

# Descriptor 3 is a duplicate of the accepted Unix connection. No request data
# is read; credentials come from the kernel and cannot be supplied in headers.
with socket.socket(fileno=3) as peer:
    raw = peer.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, struct.calcsize('3i'))
    _pid, uid, _gid = struct.unpack('3i', raw)
    print(json.dumps({'uid': uid}), flush=True)
