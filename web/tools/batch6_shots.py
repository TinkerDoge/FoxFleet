"""Web shots for 0.3.6: python tools/batch6_shots.py <outdir> (mock hub, playwright, pillow, `npm run build`)."""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3097'], stdout=subprocess.DEVNULL); time.sleep(1)
U = 'http://127.0.0.1:3097/'
def shot(page, name): page.screenshot(path=f'{out}/{name}.png'); print(name, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    c = b.new_context(viewport={'width': 390, 'height': 844}, device_scale_factor=2, is_mobile=True, has_touch=True); pg = c.new_page(); pg.set_default_timeout(8000)
    pg.goto(U); pg.wait_for_selector('input[name=username]'); pg.fill('input[name=username]', 'owner1'); pg.fill('input[name=password]', 'correct horse battery'); pg.click('button[type=submit]')
    time.sleep(1)
    pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('.chat'); pg.click('button:has-text("History")'); pg.wait_for_selector('.session-row'); time.sleep(.3)
    for i in range(4):
        pg.click(f'.session-open >> nth={i}'); time.sleep(.8)
        if pg.locator('.reasoning').count(): break
        pg.click('button:has-text("History")'); pg.wait_for_selector('.session-row')
    pg.wait_for_selector('.reasoning'); time.sleep(.5)
    pg.locator('.reasoning').first.scroll_into_view_if_needed(); shot(pg, 'web-reasoning-1-collapsed')
    pg.locator('.reasoning-head').first.click(); time.sleep(.5); shot(pg, 'web-reasoning-2-expanded')
    pg.fill('textarea', 'Summarise usage'); pg.keyboard.press('Enter')
    try:
        pg.wait_for_selector('.reasoning.live', timeout=6000); pg.locator('.reasoning-head').last.click(); time.sleep(.2); shot(pg, 'web-reasoning-3-streaming')
    except Exception as e: print('no live', e)
    time.sleep(2)
    pg.goto(U + '#/chat?agent=nova'); time.sleep(1)
    try:
        pg.set_input_files('input[type=file]', '/tmp/orange.png'); time.sleep(.5); pg.fill('textarea', 'Here is a picture'); pg.keyboard.press('Enter'); time.sleep(1.5); shot(pg, 'web-user-image')
    except Exception as e: print('image fail', e)
    b.close()
hub.terminate()
