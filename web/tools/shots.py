"""Screenshots against the mock hub: python tools/shots.py <outdir>  (needs playwright + pillow and `npm run build`; CHROME=/path/to/chrome)."""
import subprocess, sys, time, os
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3099'], env=dict(os.environ, MOCK_DELAY='140'), stdout=subprocess.DEVNULL); time.sleep(1)
U = 'http://127.0.0.1:3099/'
im = Image.new('RGB', (3200, 2400), (240, 180, 120)); d = ImageDraw.Draw(im)
for i in range(60): d.ellipse((i*50, i*30, i*50+300, i*30+300), outline=(90+i*2, 60, 40), width=8)
im.save('/tmp/sample-photo.jpg', quality=95)
def shot(page, name): page.screenshot(path=f'{out}/{name}.png'); print(name, flush=True)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox'])
    def ctx(w, h, scheme, mobile=False):
        c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, permissions=['clipboard-read', 'clipboard-write'])
        return c, c.new_page()
    def login(page):
        page.request.post(U + 'api/auth/logout', data='{}'); page.goto(U); page.wait_for_selector('input[name=username]'); page.fill('input[name=username]', 'owner1'); page.fill('input[name=password]', 'correct horse battery'); page.click('button[type=submit]'); page.wait_for_selector('.sidebar a.active, .empty-home', state='attached')
    c, pg = ctx(1280, 800, 'light'); login(pg)
    pg.click('button:has-text("Sessions")'); pg.click('[role=menuitem]:has-text("Docs indexing")'); pg.wait_for_selector('.code'); pg.wait_for_selector('.md img'); time.sleep(.5); shot(pg, '01-chat-desktop-light')
    pg.click('button:has-text("New chat")'); pg.fill('textarea', 'Summarise the fleet'); pg.click('button.send'); pg.wait_for_selector('.shimmer'); time.sleep(.9); shot(pg, '02-streaming-status')
    pg.wait_for_selector('.send:not(.stop)', timeout=30000)
    pg.goto(U + '#/manage'); pg.wait_for_selector('.list li'); shot(pg, '03-manage-agents')
    # screen takeover
    pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('button:has-text("Screen")'); pg.click('button:has-text("Screen")'); pg.wait_for_selector('button:has-text("Take over")', timeout=20000); time.sleep(1.2); shot(pg, '04-screen-view-only')
    pg.click('button:has-text("Take over")'); pg.wait_for_selector('.screen.control'); pg.mouse.move(640, 380); time.sleep(.8); shot(pg, '05-screen-in-control')
    pg.click('button:has-text("Hand back")'); pg.wait_for_selector('button:has-text("Take over")'); time.sleep(.3); shot(pg, '06-screen-handed-back')
    pg.click('button:has-text("Take over")'); pg.wait_for_selector('.screen.control')
    pg.goto(U + '#/admin'); pg.wait_for_selector('.qr'); pg.wait_for_selector('h1:has-text("Admin")'); time.sleep(.3)
    assert pg.evaluate("fetch('/api/agents/atlas/screen/status').then(r=>r.json()).then(j=>j.lease)") is None, 'leaving the screen must hand control back'
    print('auto hand-back on leave: ok', flush=True)
    pg.click('button:has-text("New invite")'); pg.wait_for_selector('.invite-fresh'); pg.click('li:has-text("guest")') if False else None; shot(pg, '07-admin')
    pg.goto(U + '#/account'); pg.wait_for_selector('h1:has-text("Devices")'); time.sleep(.3); shot(pg, '08-devices-security')
    pg.goto(U + '#/settings'); pg.wait_for_selector('.swatch'); pg.click('button[aria-label=Ocean]'); pg.click('button[role=radio]:has-text("Large")'); time.sleep(.3); shot(pg, '09-settings-ocean-large')
    pg.click('button[aria-label=Ember]'); pg.click('button[role=radio]:has-text("Default")')
    pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('.chat'); pg.keyboard.press('Tab'); time.sleep(.2); shot(pg, '10-keyboard-skip-link-focus')
    c.close()
    c, pg = ctx(1280, 800, 'dark'); login(pg); pg.goto(U + '#/admin'); pg.wait_for_selector('.qr'); time.sleep(.3); shot(pg, '11-admin-dark'); c.close()
    c, pg = ctx(390, 844, 'dark', True); login(pg); pg.click('button[aria-label=Menu]'); time.sleep(.5); shot(pg, '12-phone-drawer')
    pg.click('.sidebar a:has-text("Atlas")'); pg.click('button:has-text("Screen")'); pg.wait_for_selector('button:has-text("Take over")', timeout=20000); pg.click('button:has-text("Take over")'); pg.wait_for_selector('.keys'); time.sleep(1); shot(pg, '13-phone-screen-keys'); c.close()
    c, pg = ctx(390, 844, 'light', True); login(pg); pg.goto(U + '#/account'); pg.wait_for_selector('h1:has-text("Devices")'); time.sleep(.3); shot(pg, '14-phone-devices-light'); c.close()
    b.close()
hub.terminate()
ims = sorted(f for f in os.listdir(out) if f[:2].isdigit() and f.endswith('.png'))
W = 420; thumbs = []
for f in ims:
    t = Image.open(f'{out}/{f}').convert('RGB'); t.thumbnail((W, 300)); thumbs.append(t)
cols = 4; rows = (len(thumbs) + cols - 1) // cols; sheet = Image.new('RGB', (cols * (W + 10) + 10, rows * 310 + 10), (230, 230, 230))
for i, t in enumerate(thumbs): sheet.paste(t, (10 + (i % cols) * (W + 10), 10 + (i // cols) * 310))
sheet.save(f'{out}/contact.png')
