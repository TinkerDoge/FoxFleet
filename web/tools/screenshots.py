#!/usr/bin/env python3
"""Starts a throwaway hub + a plain static server on web/dist and captures the first-run screens (phone and desktop, light and dark).
Needs: node, `pip install playwright`, a Chrome/Chromium binary (CHROME=/path, default google-chrome). Output dir: argv[1]."""
import os, subprocess, sys, tempfile, time, json, urllib.request
from playwright.sync_api import sync_playwright
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
root = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..')
dist = os.path.join(root, 'web', 'dist'); tmp = tempfile.mkdtemp()
env = dict(os.environ, FOXFLEET_WEB_DIR=dist, FOXFLEET_CONFIG=os.path.join(tmp, 'config.json'), PORT='38091', FOXFLEET_HOST='127.0.0.1')
hub = subprocess.Popen(['node', os.path.join(root, 'server', 'index.js')], env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
static = subprocess.Popen([sys.executable, '-m', 'http.server', '38092', '-d', dist], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(2.5)
def post(path, data, cookie=None):
    req = urllib.request.Request('http://127.0.0.1:38091' + path, json.dumps(data).encode(), {'Content-Type': 'application/json', **({'Cookie': cookie} if cookie else {})})
    r = urllib.request.urlopen(req); return r.headers.get('Set-Cookie'), json.loads(r.read() or b'{}')
HUB = 'http://127.0.0.1:38091'
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=os.environ.get('CHROME', 'google-chrome'), args=['--no-sandbox'])
        def shot(name, url, scheme='light', size=(390, 780), act=None, ctx_cookies=None):
            c = b.new_context(viewport={'width': size[0], 'height': size[1]}, color_scheme=scheme, device_scale_factor=2)
            if ctx_cookies: c.add_cookies(ctx_cookies)
            pg = c.new_page(); pg.goto(url); pg.wait_for_selector('main, .shell, .boot', timeout=8000); pg.wait_for_timeout(500)
            if act: act(pg); pg.wait_for_timeout(300)
            pg.screenshot(path=f'{out}/{name}.png'); c.close()
        # 1. no hub on this origin -> hub address screen
        shot('hub-address-light', 'http://127.0.0.1:38092/')
        shot('hub-address-dark', 'http://127.0.0.1:38092/', 'dark')
        def bad(pg): pg.fill('#f-hub', 'hub.example.com'); pg.click('button.btn.primary'); pg.wait_for_selector('.error', timeout=8000)
        shot('hub-address-error', 'http://127.0.0.1:38092/', 'light', act=bad)
        # 2. first run: setup
        shot('setup-light', HUB + '/'); shot('setup-dark', HUB + '/', 'dark')
        def fill(pg): pg.fill('#f-username', 'owner'); pg.fill('#f-password', 'correct horse battery')
        shot('setup-filled-desktop', HUB + '/', 'light', (1280, 800), fill)
        # create the owner (web cookie) and some agents
        cookie, _ = post('/api/auth/setup', {'username': 'owner', 'password': 'correct horse battery', 'client': 'web'})
        ck = cookie.split(';')[0]
        post('/api/connections', {'name': 'Atlas', 'kind': 'openrouter', 'apiKey': 'sk-demo-key-123456', 'model': 'demo/model'}, ck)
        post('/api/connections', {'name': 'Orion', 'kind': 'hermes', 'connection': 'connector'}, ck)
        # 3. sign-in and join
        shot('signin-light', HUB + '/'); shot('signin-dark', HUB + '/', 'dark')
        req = urllib.request.Request(HUB + '/api/admin/settings', json.dumps({'registration': 'invite'}).encode(), {'Content-Type': 'application/json', 'Cookie': ck}, method='PUT'); urllib.request.urlopen(req)
        _, inv = post('/api/admin/invites', {}, ck)
        shot('join-light', HUB + '/?hub=' + HUB + '&invite=' + inv['code'])
        # 4. signed in
        ctxc = [{'name': ck.split('=')[0], 'value': ck.split('=', 1)[1], 'url': HUB}]
        shot('home-phone-light', HUB + '/', 'light', (390, 780), None, ctxc)
        shot('home-desktop-light', HUB + '/', 'light', (1280, 800), None, ctxc)
        shot('home-desktop-dark', HUB + '/', 'dark', (1280, 800), None, ctxc)
        shot('home-phone-drawer-dark', HUB + '/', 'dark', (390, 780), lambda pg: pg.click('.icon-btn'), ctxc)
        b.close()
finally:
    hub.terminate(); static.terminate()
