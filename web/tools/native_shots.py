"""Native Hermes session UI against the mock hub (MOCK_NATIVE=1): python tools/native_shots.py <outdir> (needs playwright + pillow and `npm run build`)."""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
env = dict(os.environ, MOCK_DELAY='40', MOCK_NATIVE='1')
hub = None
def fresh_hub():  # the mock keeps its queue in memory: one clean hub per screen size
    global hub
    if hub: hub.terminate(); hub.wait()
    hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3098'], stdout=subprocess.DEVNULL, env=env); time.sleep(1)
U = 'http://127.0.0.1:3098/'
def shot(page, name): page.screenshot(path=f'{out}/{name}.png'); print(name, flush=True)
def login(page):
    page.goto(U); page.wait_for_selector('input[name=username]'); page.fill('input[name=username]', 'owner1'); page.fill('input[name=password]', 'correct horse battery'); page.click('button[type=submit]'); page.wait_for_selector('.shell, .chat, .home', timeout=8000)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    for tag, (w, h, mobile, scheme) in {'desktop': (1280, 800, False, 'light'), 'phone': (390, 844, True, 'dark')}.items():
        fresh_hub(); c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile); pg = c.new_page(); login(pg)
        pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('.chat'); time.sleep(.6)
        assert pg.locator('select').count() == 0 and pg.locator('.controls').count() == 0, 'no mode selector, no controls'
        pg.fill('textarea', 'deploy the new build'); pg.keyboard.press('Enter'); pg.wait_for_selector('.requests', timeout=10000); time.sleep(.8); shot(pg, f'01-composer-text-send-stop-with-cards-{tag}')
        pg.click('input[type=radio] >> nth=0'); time.sleep(.3)
        pg.fill('textarea', '/queue also run the tests after'); pg.keyboard.press('Enter'); time.sleep(.7)
        pg.fill('textarea', '/steer keep the logs short'); pg.keyboard.press('Enter'); time.sleep(.7)
        pg.fill('textarea', 'actually only deploy the docs'); pg.keyboard.press('Enter'); time.sleep(.7)
        pg.evaluate("document.querySelector('.messages').scrollTo(0, 1e6)"); time.sleep(.3); shot(pg, f'02-typed-commands-and-hermes-status-{tag}')
        pg.fill('textarea', '/model'); time.sleep(.2); pg.keyboard.press('Escape'); pg.keyboard.press('Enter'); pg.wait_for_selector('.picker'); time.sleep(.5); shot(pg, f'03-model-step1-providers-{tag}')
        pg.click('.picker .choices button >> nth=0'); time.sleep(.4); shot(pg, f'04-model-step2-models-{tag}')
        pg.click('.picker .choices button >> nth=0'); time.sleep(.8); pg.evaluate("document.querySelector('.messages').scrollTo(0, 1e6)"); shot(pg, f'05-model-confirmed-in-chat-{tag}')
        if mobile:
            pg.set_viewport_size({'width': 390, 'height': 520}); pg.fill('textarea', 'keyboard open (viewport shrunk to what is left)'); time.sleep(.4); shot(pg, f'06-keyboard-open-simulated-{tag}')
        c.close()
    b.close()
hub.terminate()
ims = sorted(f for f in os.listdir(out) if f[:2].isdigit() and f.endswith('.png')); W = 420; th = []
for f in ims:
    t = Image.open(f'{out}/{f}').convert('RGB'); t.thumbnail((W, 400)); th.append(t)
cols = 4; rows = (len(th) + cols - 1) // cols; sheet = Image.new('RGB', (cols * (W + 10) + 10, rows * 410 + 10), (230, 230, 230))
for i, t in enumerate(th): sheet.paste(t, (10 + (i % cols) * (W + 10), 10 + (i // cols) * 410))
sheet.save(f'{out}/contact.png')
