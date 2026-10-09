#!/usr/bin/env python3
"""Builds the Foxfleet wordmark lockups (fox + "Foxfleet", Nunito ExtraBold) from the W3 fox. Needs Pillow and Nunito.
Usage: python3 design/tools/make-wordmarks.py [path/to/Nunito-VariableFont_wght.ttf]"""
import sys, os
from PIL import Image, ImageDraw, ImageFont
here = os.path.dirname(os.path.abspath(__file__)); brand = os.path.join(here, '..', 'brand')
font_path = sys.argv[1] if len(sys.argv) > 1 else '/usr/share/fonts/truetype/sand-box/google/Nunito/Nunito-VariableFont_wght.ttf'
fox = Image.open(os.path.join(brand, 'option-W3-transparent.png')).convert('RGBA'); fox = fox.crop(fox.getbbox())
for name, ink in (('light', '#2A2420'), ('dark', '#F6F1EA')):
    H = 400; f = ImageFont.truetype(font_path, 300); f.set_variation_by_axes([800])
    fh = int(H * 0.98); foxr = fox.resize((int(fox.width * fh / fox.height), fh), Image.LANCZOS)
    a, b = 'Fox', 'fleet'; wa, wb = f.getlength(a), f.getlength(b)
    W = int(foxr.width + 40 + wa + wb) + 20
    img = Image.new('RGBA', (W, H), (0, 0, 0, 0)); img.alpha_composite(foxr, (0, (H - fh) // 2))
    d = ImageDraw.Draw(img); x = foxr.width + 40
    d.text((x, H / 2), a, font=f, fill=ink, anchor='lm'); d.text((x + wa, H / 2), b, font=f, fill='#E0643A', anchor='lm')
    img = img.crop(img.getbbox()); img.save(os.path.join(brand, f'wordmark-{name}.png'))
