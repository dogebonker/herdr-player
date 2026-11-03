# Sends mpv JSON IPC commands over its socket and prints the replies, in order, as one JSON array.
# Usage: python3 mpvctl.py <socket> '<json array of commands>'   (exit 1: mpv isn't listening)
import json
import socket
import sys

sock, cmds = sys.argv[1], json.loads(sys.argv[2])
s = socket.socket(socket.AF_UNIX)
s.settimeout(3)
try:
    s.connect(sock)
except OSError:
    sys.exit(1)
s.sendall("".join(json.dumps({"command": c, "request_id": i}) + "\n" for i, c in enumerate(cmds)).encode())
got, buf = {}, b""
while len(got) < len(cmds):
    try:
        data = s.recv(65536)
    except socket.timeout:
        break
    if not data:
        break
    buf += data
    *lines, buf = buf.split(b"\n")
    for line in lines:
        reply = json.loads(line)
        if "request_id" in reply:
            got[reply["request_id"]] = reply
print(json.dumps([got.get(i) for i in range(len(cmds))]))
