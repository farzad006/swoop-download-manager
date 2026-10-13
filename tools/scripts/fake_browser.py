"""Sends native-messaging frames to swoop-host.exe the way a browser does.

usage: python fake_browser.py <swoop-host.exe> '<json message>' ['<json message>' ...]
"""
import json, struct, subprocess, sys

host = sys.argv[1]
payload = b""
for m in sys.argv[2:]:
    raw = json.dumps(json.loads(m)).encode()
    payload += struct.pack("<I", len(raw)) + raw
out = subprocess.run([host, "chrome-extension://fhnkijclhenhpkpllphcclallnnkkiib/"], input=payload, capture_output=True, timeout=60).stdout
while out:
    n = struct.unpack("<I", out[:4])[0]
    print(out[4:4 + n].decode())
    out = out[4 + n:]
