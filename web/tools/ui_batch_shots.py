"""UI batch 1 screenshots against the mock hub: python tools/ui_batch_shots.py <outdir> (needs playwright + pillow and `npm run build`)."""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
env = dict(os.environ, MOCK_DELAY='40', MOCK_NATIVE='1')
hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3097'], stdout=subprocess.DEVNULL, env=env); time.sleep(1)
U = 'http://127.0.0.1:3097/'
def shot(page, name): time.sleep(.4); page.screenshot(path=f'{out}/{name}.png'); print(name, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    n = 0
    for scheme in ('light', 'dark'):
        for tag, (w, h, mobile) in {'desktop': (1280, 800, False), 'phone': (390, 844, True)}.items():
            c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile); pg = c.new_page()
            pg.goto(U); pg.wait_for_selector('input[name=username]'); n += 1; shot(pg, f'{n:02d}-sign-in-{tag}-{scheme}')
            pg.fill('input[name=username]', 'owner1'); pg.fill('input[name=password]', 'correct horse battery'); pg.click('button[type=submit]'); pg.wait_for_selector('.shell', timeout=10000)
            pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('.chat'); time.sleep(.5)
            pg.fill('textarea', 'hello'); pg.keyboard.press('Enter'); time.sleep(1.2)
            assert pg.locator('.cmd-btn, [aria-label="All commands"]').count() == 0, 'no "/" button'
            n += 1; shot(pg, f'{n:02d}-chat-icons-composer-{tag}-{scheme}')
            pg.fill('textarea', '/model'); time.sleep(.2); pg.keyboard.press('Escape'); pg.keyboard.press('Enter'); pg.wait_for_selector('.picker'); time.sleep(.5)
            assert pg.locator('.picker .choices.fixed').count() == 1 and pg.locator('.picker .pager').count() == 1
            n += 1; shot(pg, f'{n:02d}-model-providers-paged-{tag}-{scheme}')
            pg.goto(U + '#/manage'); time.sleep(.8); n += 1; shot(pg, f'{n:02d}-agents-buttons-{tag}-{scheme}')
            pg.goto(U + '#/settings'); time.sleep(.6); n += 1; shot(pg, f'{n:02d}-settings-{tag}-{scheme}')
            c.close()
    b.close()
hub.terminate()
ims = sorted(f for f in os.listdir(out) if f[:2].isdigit() and f.endswith('.png')); W = 300; th = []
for f in ims:
    t = Image.open(f'{out}/{f}').convert('RGB'); t.thumbnail((W, 300)); th.append(t)
cols = 6; rows = (len(th) + cols - 1) // cols; sheet = Image.new('RGB', (cols * (W + 8) + 8, rows * 308 + 8), (230, 230, 230))
for i, t in enumerate(th): sheet.paste(t, (8 + (i % cols) * (W + 8), 8 + (i // cols) * 308))
sheet.save(f'{out}/contact-web.png')
