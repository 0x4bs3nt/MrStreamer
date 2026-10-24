#!/usr/bin/env python3
"""Compile the production native core for three SDKs, run fake-only host fixtures. No app build."""
from pathlib import Path
import gzip, http.server, json, os, subprocess, threading, time
from datetime import datetime, timedelta, timezone
os.umask(0o077)
root = Path(__file__).resolve().parent.parent
out = root / 'test-output'
out.mkdir(exist_ok=True)
xml = b'''<?xml version="1.0" encoding="UTF-8"?><tv><channel id="trusted"><display-name>News</display-name></channel><programme channel="trusted" start="20261024110000 +0000" stop="20261024140000 +0000"><title>News &amp; weather</title><desc><![CDATA[Details]]></desc></programme><programme channel="trusted" start="20261024130000 +0000"><title>Next</title></programme><programme channel="trusted" start="20261024140000 +0000" stop="20261024150000 +0000"><title>Later</title></programme><programme channel="alternate" start="20261024120000 +0000" stop="20261024160000 +0000"><title>Never fill gaps</title></programme></tv>'''
gap = b'<programme channel="gap" start="20261024110000 +0000" stop="20261024113000 +0000"><title>Ended</title></programme><programme channel="gap" start="20261024130000 +0000" stop="20261024140000 +0000"><title>After gap</title></programme>'
xml = xml.replace(b'</tv>', gap + b'</tv>')
page_rows = []
for n in range(130):
    start = datetime(2026, 10, 24, 12, tzinfo=timezone.utc) + timedelta(minutes=n)
    stop = start + timedelta(minutes=1)
    page_rows.append(f'<programme channel="pages" start="{start:%Y%m%d%H%M%S} +0000" stop="{stop:%Y%m%d%H%M%S} +0000"><title>Slot {n}</title><desc>Details {n}</desc></programme>')
pages = ('<tv>' + ''.join(page_rows) + '</tv>').encode()
packed = gzip.compress(xml)
bad = bytearray(packed); bad[-8] ^= 1
routes = {'/pages': pages, '/plain': xml, '/slow': xml, '/split-gzip': packed[:3] + b'\x04' + packed[4:10] + (65530).to_bytes(2, 'little') + b'x' * 65530 + packed[10:], '/chunks': xml, '/gzip': packed, '/members': gzip.compress(xml[:len(xml)//2]) + gzip.compress(xml[len(xml)//2:]), '/http-gzip': packed, '/double-gzip': gzip.compress(packed), '/bad-crc': bytes(bad), '/truncated-gzip': packed[:-3], '/malformed': xml[:-5], '/dtd': b'<!DOCTYPE tv [<!ENTITY x "attack">]>' + xml[38:], '/attributes': b'<tv long="' + b'a' * 70000 + b'"/>', '/empty': b'<tv/>', '/ended': xml.replace(b'20261024', b'20261001'), '/secret': xml.replace(b'News &amp; weather', b'canary-secret'), '/false-positive': xml.replace(b'News &amp; weather', b'fixture News'), '/depth': b'<tv>' + b'<x>' * 33 + b'</x>' * 33 + b'</tv>', '/html': b'<html><body>login</body></html>'}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_): pass
    def do_GET(self):
        if self.path == '/redirect':
            self.send_response(302); self.send_header('Location', '/forbidden-follow'); self.end_headers(); return
        if self.path == '/forbidden-follow': raise RuntimeError('native followed redirect')
        if self.path == '/login': self.send_response(401); self.end_headers(); return
        body = routes[self.path]
        self.send_response(200)
        if self.path in ['/http-gzip', '/double-gzip']: self.send_header('Content-Encoding', 'gzip')
        if self.path != '/chunks': self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        size = 1 if self.path == '/chunks' else 19
        for at in range(0, len(body), size):
            try:
                self.wfile.write(body[at:at+size]); self.wfile.flush()
                if self.path == '/slow': time.sleep(0.02)
            except (BrokenPipeError, ConnectionResetError): break
server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
records = []
def run(name, command):
    start = time.monotonic()
    result = subprocess.run(command, cwd=root, text=True, capture_output=True, timeout=180)
    (out / (name + '.stdout')).write_text(result.stdout)
    (out / (name + '.stderr')).write_text(result.stderr)
    record = {'name': name, 'command': command, 'exit': result.returncode, 'seconds': time.monotonic() - start}
    records.append(record); (out / 'commands.json').write_text(json.dumps(records, indent=2))
    if result.returncode: raise SystemExit(name + ' failed. See classified owned output.')
try:
    for sdk, target, tag in [('macosx', 'arm64-apple-macos14.0', 'mac'), ('iphonesimulator', 'arm64-apple-ios16.4-simulator', 'sim'), ('iphoneos', 'arm64-apple-ios16.4', 'device')]:
        sdkpath = subprocess.check_output(['xcrun', '--sdk', sdk, '--show-sdk-path'], text=True).strip()
        obj = str(out / ('system-' + tag + '.o'))
        run('c-' + tag, ['xcrun', '--sdk', sdk, 'clang', '-isysroot', sdkpath, '-target', target, '-Wall', '-Wextra', '-Werror', '-c', 'ios/core/guide_system.c', '-o', obj])
        sources = sorted(str(p.relative_to(root)) for p in (root / 'ios').glob('*.swift') if p.name != 'GuideModule.swift')
        run('swift-' + tag, ['xcrun', '--sdk', sdk, 'swiftc', '-swift-version', '5', '-sdk', sdkpath, '-target', target, '-parse-as-library', '-import-objc-header', 'ios/core/guide_system.h', *sources, 'test/main.swift', obj, '-lz', '-lsqlite3', '-o', str(out / ('fixtures-' + tag))])
        if tag == 'mac': run('fixtures-mac', [str(out / 'fixtures-mac'), str(out / 'scratch'), 'http://127.0.0.1:' + str(server.server_port)])
    print(json.dumps({'sdkCompileLinks': 6, 'productionMacFixtures': 'pass', 'iOSRuntime': False, 'expoBindingCompiled': False}))
finally:
    server.shutdown(); server.server_close()
