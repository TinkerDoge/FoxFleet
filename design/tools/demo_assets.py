"""Generated demo pictures used by the README screenshots: a usage chart, a landscape 'photo' and a remote desktop.
Everything is drawn here (no third-party artwork), so the result is reproducible. Needs: pillow, numpy.
Fonts: set FOXFLEET_FONT / FOXFLEET_MONO to .ttf files if the defaults below are missing (see docs/development)."""
import os, random
import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT = os.path.join(os.path.dirname(__file__), '..', 'demo')
SANS = [os.environ.get('FOXFLEET_FONT', ''), '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/TTF/DejaVuSans.ttf', '/Library/Fonts/Arial.ttf', 'C:/Windows/Fonts/segoeui.ttf']
MONO = [os.environ.get('FOXFLEET_MONO', ''), '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf', '/usr/share/fonts/TTF/DejaVuSansMono.ttf', '/System/Library/Fonts/Menlo.ttc', 'C:/Windows/Fonts/consola.ttf']
def font(paths, size):
    for p in paths:
        if p and os.path.exists(p): return ImageFont.truetype(p, size)
    raise SystemExit('No usable font found: set FOXFLEET_FONT / FOXFLEET_MONO to a .ttf file')

def gradient(w, h, top, bottom):
    t = np.linspace(0, 1, h)[:, None, None]; a = np.array(top)[None, None, :]; b = np.array(bottom)[None, None, :]
    return Image.fromarray((a * (1 - t) + b * t).repeat(w, axis=1).astype('uint8'))

def chart(path):
    W, H = 1200, 680; im = Image.new('RGB', (W, H), (255, 255, 255)); d = ImageDraw.Draw(im, 'RGBA')
    f, fb, fs = font(SANS, 26), font(SANS, 34), font(SANS, 22)
    d.text((48, 36), 'Tokens per day', font=fb, fill=(27, 27, 28)); d.text((48, 84), 'Last 7 days, all agents', font=fs, fill=(102, 98, 93))
    x0, y0, x1, y1 = 110, 150, W - 50, H - 90
    for i in range(5):
        y = y0 + (y1 - y0) * i / 4; d.line((x0, y, x1, y), fill=(0, 0, 0, 26), width=2); d.text((48, y - 14), f'{(4 - i) * 100}k', font=fs, fill=(155, 150, 143))
    series = {'Atlas': ((190, 74, 33), [148, 196, 172, 224, 252, 96, 130]), 'Nova': ((42, 100, 198), [92, 112, 140, 108, 160, 60, 82]), 'Echo': ((47, 122, 75), [30, 52, 44, 60, 56, 20, 28])}
    days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']; bw = (x1 - x0) / 7
    for i, day in enumerate(days):
        base = y1; cx = x0 + bw * i + bw * .18; w = bw * .64
        for name, (col, vals) in series.items():
            h = vals[i] / 400 * (y1 - y0); top = base - h
            d.rounded_rectangle((cx, top, cx + w, base), radius=8 if name == 'Echo' else 0, fill=col + (255,)); base = top
        d.text((cx + w / 2 - 20, y1 + 14), day, font=fs, fill=(102, 98, 93))
    lx = W - 380
    for j, (name, (col, _)) in enumerate(series.items()):
        d.rounded_rectangle((lx + j * 120, 48, lx + j * 120 + 20, 68), radius=6, fill=col); d.text((lx + j * 120 + 30, 44), name, font=fs, fill=(27, 27, 28))
    im.save(os.path.join(OUT, 'chart.png'), optimize=True)

def photo(path):
    rnd = random.Random(7); W, H = 1600, 1066
    sky = gradient(W, H, (36, 52, 96), (250, 176, 120)); px = np.array(sky).astype('float32')
    yy, xx = np.mgrid[0:H, 0:W]; sun = np.exp(-(((xx - W * .68) / 330) ** 2 + ((yy - H * .52) / 190) ** 2)); px += sun[..., None] * np.array([120, 90, 40])
    img = Image.fromarray(np.clip(px, 0, 255).astype('uint8')); d = ImageDraw.Draw(img, 'RGBA')
    for k, (col, base, amp) in enumerate([((74, 78, 120, 255), .56, 70), ((52, 56, 92, 255), .64, 90), ((30, 34, 62, 255), .73, 60)]):
        pts = [(0, H)]; y = H * base
        for x in range(0, W + 40, 40): y += rnd.uniform(-amp, amp) * .35; y = min(max(y, H * (base - .08)), H * (base + .06)); pts.append((x, y))
        pts.append((W, H)); d.polygon(pts, fill=col)
    img = img.filter(ImageFilter.GaussianBlur(1.6))
    water = Image.fromarray(np.clip(np.array(gradient(W, int(H * .24), (70, 60, 90), (20, 24, 44))) .astype('float32'), 0, 255).astype('uint8')); img.paste(water, (0, int(H * .76)))
    arr = np.array(img).astype('float32'); arr += np.random.default_rng(3).normal(0, 4.5, arr.shape)
    Image.fromarray(np.clip(arr, 0, 255).astype('uint8')).save(os.path.join(OUT, 'photo.jpg'), quality=86, optimize=True)

def desktop(path, W=1280, H=800):
    img = gradient(W, H, (30, 41, 74), (196, 98, 72)).convert('RGBA'); d = ImageDraw.Draw(img, 'RGBA')
    blob = Image.new('RGBA', (W, H), (0, 0, 0, 0)); bd = ImageDraw.Draw(blob)
    bd.ellipse((W * .55, H * .1, W * 1.1, H * .8), fill=(255, 170, 110, 90)); bd.ellipse((-W * .2, H * .45, W * .45, H * 1.2), fill=(90, 110, 200, 80))
    img = Image.alpha_composite(img, blob.filter(ImageFilter.GaussianBlur(90))); d = ImageDraw.Draw(img, 'RGBA')
    ui, uib, mono, monob = font(SANS, 15), font(SANS, 17), font(MONO, 15), font(MONO, 15)
    d.rectangle((0, 0, W, 30), fill=(18, 18, 22, 235)); d.text((14, 6), 'Activities', font=ui, fill=(235, 235, 235)); d.text((W / 2 - 40, 6), 'Fri 9 Oct  18:07', font=ui, fill=(235, 235, 235))
    def window(x, y, w, h, title, dark):
        sh = Image.new('RGBA', (W, H), (0, 0, 0, 0)); ImageDraw.Draw(sh).rounded_rectangle((x + 4, y + 14, x + w + 4, y + h + 14), radius=14, fill=(0, 0, 0, 120))
        nonlocal img, d; img = Image.alpha_composite(img, sh.filter(ImageFilter.GaussianBlur(14))); d = ImageDraw.Draw(img, 'RGBA')
        d.rounded_rectangle((x, y, x + w, y + h), radius=12, fill=(24, 25, 31, 255) if dark else (250, 249, 247, 255))
        d.rounded_rectangle((x, y, x + w, y + 36), radius=12, fill=(40, 42, 50, 255) if dark else (232, 229, 224, 255)); d.rectangle((x, y + 24, x + w, y + 36), fill=(40, 42, 50, 255) if dark else (232, 229, 224, 255))
        for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]): d.ellipse((x + 14 + i * 22, y + 12, x + 26 + i * 22, y + 24), fill=c)
        d.text((x + w / 2 - len(title) * 4, y + 9), title, font=ui, fill=(190, 190, 195) if dark else (90, 88, 84))
    window(70, 70, 640, 430, 'atlas — terminal', True)
    lines = [('$ git pull --ff-only', (160, 200, 255)), ('Already up to date.', (190, 190, 195)), ('$ npm test', (160, 200, 255)), ('', None), ('  ✔ pairing: single use, expiry, lockout', (110, 215, 150)), ('  ✔ connector discovers 3 profiles', (110, 215, 150)), ('  ✔ routes per agent over one socket', (110, 215, 150)), ('  ✔ secrets never reach the hub', (110, 215, 150)), ('', None), ('# tests 111   # pass 111   # fail 0', (240, 200, 110)), ('$ ./gradlew testDebugUnitTest', (160, 200, 255)), ('BUILD SUCCESSFUL in 1m 38s', (110, 215, 150)), ('$ ', (160, 200, 255))]
    for i, (t, c) in enumerate(lines):
        if t: d.text((90, 122 + i * 26), t, font=mono, fill=c)
    d.rectangle((110, 122 + 12 * 26, 120, 122 + 12 * 26 + 18), fill=(235, 235, 235, 230))
    window(520, 250, 640, 470, 'Foxfleet docs — Browser', False)
    d.rounded_rectangle((540, 296, 1140, 326), radius=15, fill=(238, 235, 230)); d.text((556, 302), 'hub.example.com/docs/agents/real-machine', font=ui, fill=(110, 105, 100))
    d.text((560, 350), 'Connect a real machine', font=font(SANS, 30), fill=(27, 27, 28)); 
    for i, t in enumerate(['One command per computer, however many', 'Hermes profiles it runs. Pair once, choose the', 'profiles to share, and watch them appear.']): d.text((560, 404 + i * 28), t, font=uib, fill=(90, 86, 82))
    d.rounded_rectangle((560, 510, 1120, 560), radius=10, fill=(30, 30, 34)); d.text((578, 524), 'curl -fsSL https://hub.example.com/c/K7QMX2PD4H | sh', font=mono, fill=(235, 235, 235))
    d.rounded_rectangle((560, 590, 760, 632), radius=21, fill=(190, 74, 33)); d.text((594, 601), 'Copy command', font=uib, fill=(255, 255, 255))
    d.rounded_rectangle((W / 2 - 150, H - 62, W / 2 + 150, H - 14), radius=24, fill=(255, 255, 255, 60))
    for i, c in enumerate([(240, 138, 93), (110, 162, 255), (108, 197, 142), (164, 141, 255), (230, 230, 230)]): d.rounded_rectangle((W / 2 - 132 + i * 54, H - 54, W / 2 - 98 + i * 54, H - 20), radius=10, fill=c + (255,))
    img.convert('RGB').save(os.path.join(OUT, 'desktop.png'), optimize=True)
    raw = np.array(img.convert('RGB').resize((W, H)))[:, :, ::-1]; alpha = np.full((H, W, 1), 255, 'uint8')
    open(os.path.join(OUT, 'desktop.bgra'), 'wb').write(np.concatenate([raw, alpha], axis=2).tobytes())

def main():
    os.makedirs(OUT, exist_ok=True); chart(OUT); photo(OUT); desktop(OUT); print('demo assets in', os.path.abspath(OUT))
if __name__ == '__main__': main()
