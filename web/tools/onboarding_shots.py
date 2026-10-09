"""Onboarding screenshots against the mock hub: python tools/onboarding_shots.py <outdir>  (playwright + pillow, `npm run build` first; CHROME=/path)."""
import subprocess, sys, time, os, json, urllib.request
from playwright.sync_api import sync_playwright
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3098'], env=dict(os.environ, MOCK_DELAY='60', MOCK_PROFILE_DELAY='2500'), stdout=subprocess.DEVNULL); time.sleep(1)
U = 'http://127.0.0.1:3098/'
def shot(page, name): page.screenshot(path=f'{out}/{name}.png'); print(name, flush=True)
try:
  with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    def run(w, h, scheme, tag, mobile=False):
        c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile)
        pg = c.new_page(); pg.goto(U); pg.wait_for_selector('input[name=username]'); pg.fill('input[name=username]', 'owner1'); pg.fill('input[name=password]', 'correct horse battery'); pg.keyboard.press('Enter'); pg.wait_for_selector('input[name=username]', state='detached'); time.sleep(.6)
        pg.goto(U + '#/manage'); pg.wait_for_selector('h2:has-text("Machines")'); time.sleep(.4); shot(pg, f'{tag}-1-machines')
        pg.click('button:has-text("Connect a machine")'); pg.wait_for_selector('.code'); pg.wait_for_selector('.qr'); time.sleep(.4); shot(pg, f'{tag}-2-connect-waiting')
        code = pg.inner_text('.code').replace('-', '')
        req = urllib.request.Request(U + 'api/machines/redeem', data=json.dumps({'code': code, 'name': 'Home server'}).encode(), headers={'Content-Type': 'application/json'}); urllib.request.urlopen(req).read()
        pg.wait_for_selector('text=Looking for profiles', timeout=8000); shot(pg, f'{tag}-3-paired')
        pg.wait_for_selector('text=Found 3 profiles: default, coder, research', timeout=10000); time.sleep(.3); shot(pg, f'{tag}-4-found')
        pg.click('button:has-text("Done")'); pg.wait_for_selector('li:has-text("Home server")'); time.sleep(.3); shot(pg, f'{tag}-5-list'); c.close()
    run(1280, 900, 'light', 'desktop-light'); run(1280, 900, 'dark', 'desktop-dark'); run(390, 844, 'light', 'phone-light', True)
    b.close()
finally: hub.terminate()
