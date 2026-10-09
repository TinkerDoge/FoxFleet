"""History, formatted old conversation and command palette against the mock hub: python tools/fixes_shots.py <outdir> (needs playwright + pillow and `npm run build`)."""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3098'], stdout=subprocess.DEVNULL); time.sleep(1)
U = 'http://127.0.0.1:3098/'
def shot(page, name): page.screenshot(path=f'{out}/{name}.png'); print(name, flush=True)
def login(page):
    page.goto(U); page.wait_for_selector('input[name=username]'); page.fill('input[name=username]', 'owner1'); page.fill('input[name=password]', 'correct horse battery'); page.click('button[type=submit]'); page.wait_for_selector('.sidebar a.active, .empty-home', state='attached')
with sync_playwright() as p:
    os.environ.setdefault('X', '1')
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    for tag, (w, h, mobile, scheme) in {'desktop': (1280, 800, False, 'light'), 'phone': (390, 844, True, 'dark')}.items():
        c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile); pg = c.new_page(); login(pg)
        pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('.chat'); time.sleep(.4)
        pg.click('button:has-text("History")'); pg.wait_for_selector('.session-list li'); time.sleep(.3); shot(pg, f'01-history-{tag}')
        pg.click('.session-open >> nth=2'); pg.wait_for_selector('.md img, .md pre', timeout=10000); time.sleep(.8); shot(pg, f'02-old-conversation-{tag}')
        pg.fill('textarea', '/'); pg.wait_for_selector('[role=listbox], .suggestions'); time.sleep(.3); shot(pg, f'03-commands-{tag}')
        pg.fill('textarea', '/mo'); time.sleep(.3); shot(pg, f'04-commands-filtered-{tag}')
        c.close()
    b.close()
hub.terminate()
ims = sorted(f for f in os.listdir(out) if f[:2].isdigit() and f.endswith('.png')); W = 420; th = []
for f in ims:
    t = Image.open(f'{out}/{f}').convert('RGB'); t.thumbnail((W, 400)); th.append(t)
cols = 4; rows = (len(th) + cols - 1) // cols; sheet = Image.new('RGB', (cols * (W + 10) + 10, rows * 410 + 10), (230, 230, 230))
for i, t in enumerate(th): sheet.paste(t, (10 + (i % cols) * (W + 10), 10 + (i // cols) * 410))
sheet.save(f'{out}/contact-web.png')
