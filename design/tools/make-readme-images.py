#!/usr/bin/env python3
"""Rebuilds every README / docs-site picture from the REAL UI.

  web      the real built web app (web/dist) served by the mock hub with seeded demo data, captured with headless Chrome at 2x
  android  the Compose screens rendered by Roborazzi (android/app .../ReadmeScreenshotTest) at xxhdpi
  compose  framed on a soft Foxfleet gradient (browser window / phone bezel drawn here) + hero + social preview

Usage:  python design/tools/make-readme-images.py [--skip-web] [--skip-android] [--artifacts DIR]
Needs:  pip install playwright pillow numpy ; playwright with a Chrome (CHROME=/path/to/chrome) ; `cd web && npm ci && npm run build`
Output: docs/images/*.webp|jpg (README) and site/public/img/ (docs site). Fonts: see docs/development (FOXFLEET_FONT / FOXFLEET_MONO)."""
import argparse, glob, os, shutil, subprocess, sys, time, json, urllib.request
from PIL import Image, ImageDraw, ImageFilter, ImageFont
import numpy as np

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
RAW = os.path.join(ROOT, 'build', 'readme-raw')
IMG = os.path.join(ROOT, 'docs', 'images')
SITE_IMG = os.path.join(ROOT, 'site', 'public', 'img')
sys.path.insert(0, os.path.dirname(__file__))
FONT_PATHS = [os.environ.get('FOXFLEET_FONT', ''), '/usr/share/fonts/truetype/sand-box/google/Inter/Inter-VariableFont_opsz,wght.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 'C:/Windows/Fonts/segoeuib.ttf']

# ---------------------------------------------------------------- web
def web_shots():
    from playwright.sync_api import sync_playwright
    os.makedirs(RAW, exist_ok=True)
    hub = subprocess.Popen(['node', 'web/tools/mock-hub.mjs', '3097'], cwd=ROOT, env=dict(os.environ, MOCK_DELAY='12', MOCK_DESKTOP='1', MOCK_PROFILE_DELAY='1800'), stdout=subprocess.DEVNULL); time.sleep(1.2)
    U = 'http://127.0.0.1:3097/'
    def shot(pg, name): pg.screenshot(path=f'{RAW}/web-{name}.png'); print('web', name, flush=True)
    def imgs(pg): pg.wait_for_function("[...document.images].every(i => i.complete && i.naturalWidth > 0)", timeout=15000); time.sleep(.4)
    try:
        with sync_playwright() as p:
            b = p.chromium.launch(executable_path=os.environ.get('CHROME', '/usr/bin/google-chrome'), args=['--no-sandbox', '--font-render-hinting=none'])
            def session(w, h, scheme, mobile=False):
                c = b.new_context(viewport={'width': w, 'height': h}, color_scheme=scheme, device_scale_factor=2, is_mobile=mobile, has_touch=mobile)
                pg = c.new_page(); pg.goto(U); pg.wait_for_selector('input[name=username]'); pg.fill('input[name=username]', 'owner1'); pg.fill('input[name=password]', 'correct horse battery'); pg.keyboard.press('Enter')
                pg.wait_for_selector('input[name=username]', state='detached'); time.sleep(.8); return c, pg
            def open_report(pg, mobile=False):
                pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('.chat'); time.sleep(.3)
                pg.click('button:has-text("Sessions")'); pg.click('[role=menuitem]:has-text("Weekly usage summary")'); pg.wait_for_selector('.md table'); imgs(pg)
                pg.evaluate("document.querySelector('.messages')?.scrollTo(0, 0)"); time.sleep(.3)
            for scheme in ('light', 'dark'):
                c, pg = session(1440, 900, scheme); open_report(pg); shot(pg, f'chat-{scheme}')
                if scheme == 'light':
                    pg.click('button:has-text("New chat")'); pg.fill('textarea', 'Find the three biggest risks in the release checklist.'); pg.click('button.send'); pg.wait_for_selector('.shimmer'); time.sleep(1.1); shot(pg, 'streaming-light'); pg.wait_for_selector('.send:not(.stop)', timeout=30000)
                    pg.goto(U + '#/manage'); pg.wait_for_selector('h2:has-text("Machines")'); time.sleep(.4)
                    pg.click('button:has-text("Connect a machine")'); pg.wait_for_selector('.qr'); time.sleep(.4)
                    code = pg.inner_text('.code').replace('-', '')
                    urllib.request.urlopen(urllib.request.Request(U + 'api/machines/redeem', data=json.dumps({'code': code, 'name': 'Workstation'}).encode(), headers={'Content-Type': 'application/json'})).read()
                    pg.wait_for_selector('text=Found 3 profiles', timeout=12000); time.sleep(.4); shot(pg, 'machines-light')
                    pg.goto(U + '#/settings'); pg.wait_for_selector('.swatch'); time.sleep(.4); shot(pg, 'settings-light')
                else:
                    pg.goto(U + '#/chat?agent=atlas'); pg.wait_for_selector('button:has-text("Screen")'); pg.click('button:has-text("Screen")'); pg.wait_for_selector('button:has-text("Take over")', timeout=20000); time.sleep(1.5)
                    pg.click('button:has-text("Take over")'); pg.wait_for_selector('.screen.control'); pg.mouse.move(760, 430); time.sleep(1.0); shot(pg, 'screen-dark')
                    pg.click('button:has-text("Hand back")'); time.sleep(.3)
                    pg.goto(U + '#/admin'); pg.wait_for_selector('.qr'); pg.click('button:has-text("New invite")'); pg.wait_for_selector('.invite-fresh'); time.sleep(.5); shot(pg, 'admin-dark')
                c.close()
            for scheme in ('light', 'dark'):
                c, pg = session(390, 844, scheme, True); open_report(pg, True); shot(pg, f'phone-chat-{scheme}')
                if scheme == 'dark':
                    pg.click('button[aria-label=Menu]'); time.sleep(.6); shot(pg, 'phone-fleet-dark')
                else:
                    pg.goto(U + '#/manage'); pg.wait_for_selector('h2:has-text("Machines")'); pg.click('button:has-text("Connect a machine")'); pg.wait_for_selector('.qr'); time.sleep(.4)
                    code = pg.inner_text('.code').replace('-', '')
                    urllib.request.urlopen(urllib.request.Request(U + 'api/machines/redeem', data=json.dumps({'code': code, 'name': 'Laptop'}).encode(), headers={'Content-Type': 'application/json'})).read()
                    pg.wait_for_selector('text=Found 3 profiles', timeout=12000); pg.evaluate('window.scrollTo(0, 120)'); time.sleep(.4); shot(pg, 'phone-machines-light')
                c.close()
            b.close()
    finally: hub.terminate()

def android_shots():
    subprocess.run(['./gradlew', '--offline', 'recordRoborazziDebug', '--tests', '*ReadmeScreenshotTest', '-q'], cwd=os.path.join(ROOT, 'android'), check=True)
    os.makedirs(RAW, exist_ok=True)
    for f in glob.glob(os.path.join(ROOT, 'android', 'app', 'build', 'outputs', 'roborazzi', 'readme-*.png')): shutil.copy(f, os.path.join(RAW, 'android-' + os.path.basename(f)[7:]))

# ---------------------------------------------------------------- composition
def font(size):
    for p in FONT_PATHS:
        if p and os.path.exists(p):
            f = ImageFont.truetype(p, size)
            try: f.set_variation_by_axes([32, 700])
            except Exception: pass
            return f
    raise SystemExit('No usable font: set FOXFLEET_FONT to a .ttf file')

def backdrop(w, h, dark=False):
    t = np.linspace(0, 1, w)[None, :, None] * .5 + np.linspace(0, 1, h)[:, None, None] * .5
    a, b, c = np.array([253, 238, 226]), np.array([246, 226, 208]), np.array([236, 214, 196])
    px = np.where(t < .5, a * (1 - t * 2) + b * (t * 2), b * (1 - (t - .5) * 2) + c * ((t - .5) * 2))
    im = Image.fromarray(px.astype('uint8')).convert('RGBA')
    blobs = Image.new('RGBA', (w, h), (0, 0, 0, 0)); d = ImageDraw.Draw(blobs)
    d.ellipse((w * .55, -h * .3, w * 1.15, h * .5), fill=(240, 138, 93, 95)); d.ellipse((-w * .15, h * .55, w * .4, h * 1.25), fill=(190, 74, 33, 55)); d.ellipse((w * .3, h * .7, w * .75, h * 1.2), fill=(255, 255, 255, 120))
    return Image.alpha_composite(im, blobs.filter(ImageFilter.GaussianBlur(max(w, h) // 14)))

def shadow(canvas, box, radius, blur, alpha=95, dy=0):
    s = Image.new('RGBA', canvas.size, (0, 0, 0, 0)); ImageDraw.Draw(s).rounded_rectangle((box[0], box[1] + dy, box[2], box[3] + dy), radius=radius, fill=(60, 30, 10, alpha))
    return Image.alpha_composite(canvas, s.filter(ImageFilter.GaussianBlur(blur)))

def rounded(im, r):
    m = Image.new('L', im.size, 0); ImageDraw.Draw(m).rounded_rectangle((0, 0, im.width - 1, im.height - 1), radius=r, fill=255); out = im.convert('RGBA'); out.putalpha(m); return out

def browser(shot, dark=False, url='hub.example.com'):
    """A quiet browser window (no vendor marks) around a 2x web screenshot; returns RGBA with transparent margin."""
    s = Image.open(shot).convert('RGB'); bar = 88; pad = 70; r = 36
    W, H = s.width, s.height + bar
    out = Image.new('RGBA', (W + pad * 2, H + pad * 2), (0, 0, 0, 0)); out = shadow(out, (pad, pad, pad + W, pad + H), r, 38, 80, 26)
    win = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(win)
    d.rectangle((0, 0, W, bar), fill=(36, 36, 40, 255) if dark else (240, 236, 230, 255))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]): d.ellipse((34 + i * 40, 33, 56 + i * 40, 55), fill=c)
    pw = min(900, W // 2); d.rounded_rectangle((W / 2 - pw / 2, 20, W / 2 + pw / 2, bar - 20), radius=24, fill=(58, 58, 64, 255) if dark else (255, 255, 255, 255))
    f = font(26); tw = d.textlength(url, font=f); d.text((W / 2 - tw / 2, 28), url, font=f, fill=(200, 200, 205) if dark else (102, 98, 93))
    win.paste(s, (0, bar)); out.alpha_composite(rounded(win, r), (pad, pad)); return out

def phone(shot):
    """A generic phone bezel (no brand marks) around a screenshot."""
    s = Image.open(shot).convert('RGB'); bz = 26; r = 120; pad = 60
    W, H = s.width + bz * 2, s.height + bz * 2
    out = Image.new('RGBA', (W + pad * 2, H + pad * 2), (0, 0, 0, 0)); out = shadow(out, (pad, pad, pad + W, pad + H), r, 44, 100, 30)
    body = Image.new('RGBA', (W, H), (0, 0, 0, 0)); d = ImageDraw.Draw(body)
    d.rounded_rectangle((0, 0, W - 1, H - 1), radius=r, fill=(22, 22, 25, 255), outline=(78, 78, 86, 255), width=3)
    scr = rounded(s, r - bz); body.alpha_composite(scr, (bz, bz)); d = ImageDraw.Draw(body)
    d.ellipse((W / 2 - 12, bz + 12, W / 2 + 12, bz + 36), fill=(10, 10, 12, 255))
    d.rounded_rectangle((W - 4, 330, W + 2, 470), radius=3, fill=(60, 60, 66, 255))
    out.alpha_composite(body, (pad, pad)); return out

def fit(im, w=None, h=None):
    if w: return im.resize((w, int(im.height * w / im.width)), Image.LANCZOS)
    return im.resize((int(im.width * h / im.height), h), Image.LANCZOS)

def on_backdrop(items, size, fox=None):
    canvas = backdrop(*size)
    for im, xy in items: canvas.alpha_composite(im, xy)
    if fox: canvas.alpha_composite(*fox)
    return canvas

def save(im, name, q=82, limit=300_000):
    os.makedirs(IMG, exist_ok=True); path = os.path.join(IMG, name); rgb = im.convert('RGB')
    if name.endswith('.jpg'): rgb.save(path, quality=q, optimize=True, progressive=True)
    else:
        while True:
            rgb.save(path, 'WEBP', quality=q, method=6)
            if os.path.getsize(path) <= limit or q <= 50: break
            q -= 6
    print(f'{name}: {rgb.width}x{rgb.height} {os.path.getsize(path) // 1024} KB', flush=True); return path

def compose():
    R = lambda n: os.path.join(RAW, n)
    fox = Image.open(os.path.join(ROOT, 'design', 'brand', 'option-W3-transparent.png')).convert('RGBA')
    web = {n: browser(R(f'web-{n}.png'), dark=n.endswith('dark')) for n in ['chat-light', 'chat-dark', 'streaming-light', 'machines-light', 'settings-light', 'screen-dark', 'admin-dark']}
    ph = {n: phone(R(f'web-{n}.png')) for n in ['phone-chat-light', 'phone-chat-dark', 'phone-fleet-dark', 'phone-machines-light']}
    an = {n: phone(R(f'android-{n}.png')) for n in ['fleet-light', 'chat-dark', 'machines-dark', 'screen-dark', 'chat-streaming-light', 'chat-light', 'fleet-dark', 'machines-light']}
    # singles: one framed window / phone on the backdrop
    for n, im in web.items():
        w = 1700; f = fit(im, w - 120); save(on_backdrop([(f, (60, 30))], (w, f.height + 60)), f'web-{n}.webp')
    for n, im in {**{'web-' + k: v for k, v in ph.items()}, **{'android-' + k: v for k, v in an.items()}}.items():
        f = fit(im, h=1500); save(on_backdrop([(f, (90, 30))], (f.width + 180, f.height + 60)), f'{n}.webp', q=84)
    # README row: three phones
    trio = [fit(an['fleet-light'], h=1360), fit(an['chat-dark'], h=1360), fit(an['machines-dark'], h=1360)]
    W = sum(i.width for i in trio) + 120; c = backdrop(W, 1440); x = 60
    for i in trio: c.alpha_composite(i, (x - 30, 40)); x += i.width - 20
    save(c, 'android-trio.webp')
    # hero: browser window + phone, fox peeking in
    b = fit(web['chat-light'], 1560); p = fit(ph['phone-chat-dark'], h=1000); foxs = fox.resize((240, 240), Image.LANCZOS)
    c = on_backdrop([(b, (0, 90)), (p, (1330, 250))], (1900, 1250)); c.alpha_composite(foxs, (1560, 10)); save(c, 'hero.webp', q=84)
    # social preview 1280x640
    W, H = 1280, 640; c = backdrop(W, H)
    wb = fit(web['chat-light'], 940); c.alpha_composite(wb, (560, 150)); pp = fit(ph['phone-chat-dark'], h=520); c.alpha_composite(pp, (1120, 150))
    d = ImageDraw.Draw(c); wm = Image.open(os.path.join(ROOT, 'design', 'brand', 'wordmark-light.png')).convert('RGBA'); wm = fit(wm, 400); c.alpha_composite(wm, (46, 70))
    d.text((56, 280), 'One calm place for', font=font(50), fill=(27, 27, 28)); d.text((56, 342), 'all your AI agents', font=font(50), fill=(190, 74, 33))
    sf = font(28); sf.set_variation_by_axes([32, 450]) if hasattr(sf, 'set_variation_by_axes') else None
    d.text((58, 440), 'Self-hosted · web + Android · alpha', font=sf, fill=(102, 98, 93)); d.text((58, 484), 'MIT licensed', font=sf, fill=(102, 98, 93))
    save(c, 'og.jpg', q=88)
    # contact sheet for review
    names = sorted(os.listdir(IMG)); th = []
    for n in names:
        im = Image.open(os.path.join(IMG, n)).convert('RGB'); th.append(im.resize((int(im.width * 360 / im.height), 360)))
    cols, rows, x, y, rowh = 0, [], 10, 10, 370
    sheet = Image.new('RGB', (2400, 10 + rowh * (1 + len(th) // 4 + 1)), (40, 40, 44)); x = y = 10
    for t in th:
        if x + t.width > 2390: x, y = 10, y + rowh
        sheet.paste(t, (x, y)); x += t.width + 10
    return sheet.crop((0, 0, 2400, y + rowh))

def main():
    ap = argparse.ArgumentParser(); ap.add_argument('--skip-web', action='store_true'); ap.add_argument('--skip-android', action='store_true'); ap.add_argument('--artifacts'); a = ap.parse_args()
    import demo_assets; demo_assets.main()
    if not a.skip_web: web_shots()
    if not a.skip_android: android_shots()
    sheet = compose()
    os.makedirs(SITE_IMG, exist_ok=True)
    for f in glob.glob(os.path.join(SITE_IMG, '*')): os.remove(f)
    for f in glob.glob(os.path.join(IMG, '*')): shutil.copy(f, SITE_IMG)
    if a.artifacts:
        os.makedirs(a.artifacts, exist_ok=True); sheet.save(os.path.join(a.artifacts, 'contact.png'))
        for f in glob.glob(os.path.join(IMG, '*')): shutil.copy(f, a.artifacts)

if __name__ == '__main__': main()
