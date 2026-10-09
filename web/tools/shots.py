"""Screenshots against the mock hub: python tools/shots.py <outdir>  (needs playwright + pillow, `npm run build` first)."""
import subprocess, sys, time, os, io
from playwright.sync_api import sync_playwright
from PIL import Image, ImageDraw
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
env = dict(os.environ, MOCK_DELAY='140')
hub = subprocess.Popen(['node', 'tools/mock-hub.mjs', '3099'], env=env, stdout=subprocess.DEVNULL); time.sleep(1)
U = 'http://127.0.0.1:3099/'
im = Image.new('RGB', (3200, 2400), (240, 180, 120)); d = ImageDraw.Draw(im)
for i in range(60): d.ellipse((i*50, i*30, i*50+300, i*30+300), outline=(90+i*2, 60, 40), width=8)
im.save('/tmp/sample-photo.jpg', quality=95); open('/tmp/report.txt', 'wb').write(os.urandom(300000))
def shot(page, name): page.screenshot(path=f'{out}/{name}.png'); print(name)
with sync_playwright() as p:
    b = p.chromium.launch(executable_path=os.environ.get('CHROME', 'google-chrome'), args=['--no-sandbox'])
    def ctx(w, h, scheme, mobile=False):
        c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2 if mobile else 1, is_mobile=mobile, has_touch=mobile, permissions=['clipboard-read', 'clipboard-write'], reduced_motion='no-preference')
        return c, c.new_page()
    def login(page):
        page.request.post(U + 'api/auth/logout', data='{}'); page.goto(U); page.wait_for_selector('input[name=username]'); page.fill('input[name=username]', 'owner1'); page.fill('input[name=password]', 'correct horse battery'); page.click('button[type=submit]'); page.wait_for_selector('.sidebar a.active, .empty-home')
    # --- desktop light
    c, pg = ctx(1280, 800, 'light'); login(pg)
    pg.click('button:has-text("Sessions")'); pg.click('[role=menuitem]:has-text("Docs indexing")'); pg.wait_for_selector('.code'); time.sleep(.4); shot(pg, '01-chat-desktop-light')
    pg.click('.code .copy'); time.sleep(.2); assert 'Copied' in pg.inner_text('.code .copy')
    pg.click('button:has-text("New chat")')
    pg.fill('textarea', '/re'); time.sleep(.3); shot(pg, '02-autocomplete')
    pg.fill('textarea', 'Summarise the fleet'); pg.click('button.send'); pg.wait_for_selector('.shimmer'); time.sleep(.9); shot(pg, '03-streaming-status')
    pg.wait_for_selector('.send:not(.stop)', timeout=30000); time.sleep(.5)
    pg.set_input_files('input[type=file]:not([capture])', ['/tmp/sample-photo.jpg', '/tmp/report.txt']) if False else None
    ins = pg.query_selector_all('input[type=file]'); ins[0].set_input_files('/tmp/sample-photo.jpg'); ins[2].set_input_files('/tmp/report.txt'); pg.wait_for_selector('.att img'); time.sleep(.3); shot(pg, '04-attachments')
    pg.fill('textarea', 'Here is a photo and a report'); pg.click('button.send'); pg.wait_for_selector('.thumb'); pg.wait_for_selector('.send:not(.stop)', timeout=30000)
    pg.click('.thumb img'); pg.wait_for_selector('.viewer'); pg.dblclick('.viewer-media'); time.sleep(.3); shot(pg, '05-media-viewer'); pg.keyboard.press('Escape')
    pg.goto(U + '#/manage'); pg.wait_for_selector('.list li'); shot(pg, '06-manage-agents')
    pg.click('button:has-text("Add agent")'); pg.wait_for_selector('.list li'); shot(pg, '07-pick-type')
    pg.click('li:has-text("Hermes agent")'); pg.fill('input[name=name]', 'orbit'); pg.click('button[role=radio]:has-text("direct")'); pg.click('summary'); pg.fill('input[name=host]', 'agent-box'); pg.fill('input[name=port]', '8642'); pg.click('button:has-text("Test connection")'); pg.wait_for_selector('.checks'); time.sleep(.2); shot(pg, '08-add-agent-test')
    pg.click('button[role=radio]:has-text("connector")'); pg.click('button:has-text("Save")'); pg.wait_for_selector('.secret'); shot(pg, '09-bootstrap-once')
    pg.click('button:has-text("Done")'); pg.click('li:has-text("Nova") button:has-text("Edit")'); pg.wait_for_selector('input[name=apiKey]'); shot(pg, '10-edit-secret-kept')
    c.close()
    # --- desktop dark
    c, pg = ctx(1280, 800, 'dark'); login(pg); pg.click('button:has-text("Sessions")'); pg.click('[role=menuitem]:has-text("Docs indexing")'); pg.wait_for_selector('.code'); time.sleep(.4); shot(pg, '11-chat-desktop-dark'); c.close()
    # --- phone
    c, pg = ctx(390, 844, 'dark', True); login(pg); pg.click('button[aria-label=Menu]') if pg.is_visible('button[aria-label=Menu]') else None; time.sleep(.4); shot(pg, '12-phone-drawer')
    pg.click('.sidebar a:has-text("Atlas")'); time.sleep(.3); pg.click('button:has-text("Sessions")'); pg.click('[role=menuitem]:has-text("Docs indexing")'); pg.wait_for_selector('.code'); time.sleep(.4); shot(pg, '13-phone-chat-dark'); c.close()
    c, pg = ctx(390, 844, 'light', True); login(pg); pg.goto(U + '#/manage'); pg.wait_for_selector('.list li'); shot(pg, '14-phone-manage-light'); c.close()
    # --- reduced motion
    c = b.new_context(viewport={'width': 800, 'height': 600}, reduced_motion='reduce'); pg = c.new_page(); login(pg); pg.fill('textarea', 'hi'); pg.click('button.send'); pg.wait_for_selector('.shimmer')
    print('reduced-motion animation:', pg.eval_on_selector('.shimmer', 'e => getComputedStyle(e).animationName')); c.close()
    b.close()
hub.terminate()
ims = sorted(f for f in os.listdir(out) if f[:2].isdigit() and f.endswith('.png'))
W = 420; thumbs = []
for f in ims:
    t = Image.open(f'{out}/{f}').convert('RGB'); t.thumbnail((W, 300)); thumbs.append(t)
cols = 4; rows = (len(thumbs) + cols - 1) // cols; sheet = Image.new('RGB', (cols * (W + 10) + 10, rows * 310 + 10), (230, 230, 230))
for i, t in enumerate(thumbs): sheet.paste(t, (10 + (i % cols) * (W + 10), 10 + (i // cols) * 310))
sheet.save(f'{out}/contact.png')
