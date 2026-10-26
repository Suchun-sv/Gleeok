"""Turn a devscript recording into evenly timed frames for an animated README clip.

    python dev/readme-clip.py <recording dir> <frames dir> [width]

The recording (see the devscript's `record` step) has PNG frames taken whenever the app could be
captured, with their times, the pointer, and, for the main window, its pages as layers. Here the
layers are put back on the window, frames are picked at a steady rate, and the pointer and any
labels (shortcuts pressed) are drawn on top, since a capture never shows the pointer.
"""
import glob
import json
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

src, dst = sys.argv[1:3]
width = int(sys.argv[3]) if len(sys.argv) > 3 else 1200
FPS = 15
os.makedirs(dst, exist_ok=True)
for f in glob.glob(os.path.join(dst, '*.png')):
    os.remove(f)

rec = json.load(open(os.path.join(src, 'frames.json')))
frames, labels = rec['frames'], rec['labels']
key_font = ImageFont.truetype(subprocess.run(['fc-match', '-f', '%{file}', 'DejaVu Sans:bold'], capture_output=True, text=True).stdout, 30)

cache = {}


def composite(f):
    if f['file'] not in cache:
        img = Image.open(os.path.join(src, f['file'])).convert('RGB')
        for layer in f['layers']:
            img.paste(Image.open(os.path.join(src, layer['file'])).convert('RGB'), (layer['x'], layer['y']))
        cache.clear()
        cache[f['file']] = img
    return cache[f['file']].copy()


def cursor(d, x, y, pressed):
    pts = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12), (12.5, 12)]
    k = 1.5
    if pressed:
        d.ellipse([x - 16, y - 16, x + 16, y + 16], fill=(90, 150, 255, 70), outline=(110, 165, 255, 230), width=3)
    d.polygon([(x + px * k, y + py * k) for px, py in pts], fill=(255, 255, 255, 255), outline=(0, 0, 0, 255))


def badge(img, text, alpha):
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = d.textlength(text, font=key_font) + 44
    x0, y0 = (img.width - w) / 2, img.height - 110
    d.rounded_rectangle([x0, y0, x0 + w, y0 + 56], 12, fill=(20, 22, 30, int(235 * alpha)), outline=(110, 120, 170, int(255 * alpha)), width=2)
    d.text((img.width / 2, y0 + 28), text, font=key_font, fill=(240, 242, 255, int(255 * alpha)), anchor='mm')
    img.alpha_composite(layer)


end = frames[-1]['t']
n = 0
i = 0
t = 0.0
while t <= end:
    while i + 1 < len(frames) and frames[i + 1]['t'] <= t:
        i += 1
    f = frames[i]
    img = composite(f).convert('RGBA')
    for lab in labels:
        age = (t - lab['t']) / 1000
        if 0 <= age < 1.4:
            badge(img, lab['text'], min(1, age / 0.15, (1.4 - age) / 0.3))
    if f['cursor']:
        overlay = Image.new('RGBA', img.size, (0, 0, 0, 0))
        cursor(ImageDraw.Draw(overlay), f['cursor']['x'], f['cursor']['y'], f['cursor']['down'])
        img.alpha_composite(overlay)
    img = img.convert('RGB')
    img.resize((width, round(img.height * width / img.width)), Image.LANCZOS).save(os.path.join(dst, f'{n:04d}.png'))
    n += 1
    t += 1000 / FPS
print(f'{n} frames, {n / FPS:.1f}s')
