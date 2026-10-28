"""Turn the keyframes of dev/readme-demo.json into the frames of the README's animated demo.

    python dev/readme-demo.py <captures dir> <capture log> <frames dir>

Two screens side by side: the main window on the left, the second screen on the right. The motion
(cursor, the notes pane flying to the second screen, scene switches) is drawn here, so a rerun
gives the same animation however fast the pages loaded.
"""
import glob
import json
import os
import re
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFont

caps, log, frames = sys.argv[1:4]
os.makedirs(frames, exist_ok=True)
for f in glob.glob(os.path.join(frames, '*.png')):
    os.remove(f)

FPS = 25
W, H = 1600, 640
SW, SH = 1600, 1000  # the captured screen
S = 0.45  # screen scale on the canvas
MW, MH = int(SW * S), int(SH * S)
LEFT = (50, 104)  # top-left of each screen on the canvas
RIGHT = (W - 50 - MW, 104)


def font(name, size, index=0):
    path = subprocess.run(['fc-match', '-f', '%{file}', name], capture_output=True, text=True).stdout
    return ImageFont.truetype(path, size, index=index)


TITLE = font('Noto Sans CJK SC:bold', 30, index=2)
SUB = font('Noto Sans CJK SC', 17, index=2)
KEY = font('Noto Sans CJK SC:bold', 28, index=2)


def load(name):
    return Image.open(os.path.join(caps, name)).convert('RGB')


sat_id = re.search(r'k2__(w_[^.]+)\.png', ' '.join(os.listdir(caps))).group(1)
full = {
    'k1': load('k1__main.png'),
    **{f'k{i}': load(f'k{i}__main.png') for i in (2, 3, 4)},
    **{f's{i}': load(f'k{i}__{sat_id}.png') for i in (2, 3, 4)},
}
small = {k: v.resize((MW, MH), Image.LANCZOS) for k, v in full.items()}

# Pane rects and ⧉ buttons in the main window at k1, logged by the devscript.
info = json.loads(re.search(r'detach-at (\{.*\})', open(log).read()).group(1))
pane = info['panes'][2]  # [x, y, w, h] of the 笔记 pane
detach_btn = info['buttons'][2]
small_pane = small['k1'].crop(tuple(int(v * S) for v in (pane[0], pane[1], pane[0] + pane[2], pane[1] + pane[3])))
# The main screen while the pane is away: its column left empty.
k1_gap = small['k1'].copy()
ImageDraw.Draw(k1_gap).rectangle([int(pane[0] * S), int(pane[1] * S), MW, MH], fill=(24, 25, 31))
small['k1gap'] = k1_gap


def wallpaper():
    img = Image.new('RGB', (MW, MH))
    d = ImageDraw.Draw(img)
    for y in range(MH):
        t = y / MH
        d.line([(0, y), (MW, y)], fill=(int(30 + 14 * t), int(34 + 10 * t), int(52 + 18 * t)))
    return img


WALL = wallpaper()


def background():
    img = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(img)
    for y in range(H):
        t = y / H
        d.line([(0, y), (W, y)], fill=(int(58 - 30 * t), int(62 - 34 * t), int(104 - 52 * t)))
    for x, y in (LEFT, RIGHT):
        d.rounded_rectangle([x - 9, y - 9, x + MW + 9, y + MH + 9], 12, fill=(12, 12, 16))
        cx = x + MW // 2
        d.polygon([(cx - 26, y + MH + 9), (cx + 26, y + MH + 9), (cx + 34, y + MH + 38), (cx - 34, y + MH + 38)], fill=(38, 40, 52))
        d.rounded_rectangle([cx - 90, y + MH + 36, cx + 90, y + MH + 44], 4, fill=(48, 50, 64))
    sub = ImageFont.truetype(SUB.path, 15, index=2)
    for (x, y), label in ((LEFT, '主屏'), (RIGHT, '第二块屏')):
        d.text((x + MW // 2, y + MH + 62), label, font=sub, fill=(150, 156, 190), anchor='mm')
    return img


BG = background()
SCENES = {
    'k1': ('读论文', 'AI 对话 · PDF 阅读器 · 笔记'),
    'k2': ('读论文', 'AI 对话 · PDF 阅读器 · 笔记'),
    'k3': ('写论文', 'AI 对话 · Overleaf · 文献库'),
    'k4': ('做实验', 'AI 对话 · 终端 · 日程'),
}


def ease(t):
    t = max(0.0, min(1.0, t))
    return 4 * t * t * t if t < 0.5 else 1 - (-2 * t + 2) ** 3 / 2


def to_canvas(origin, x, y):
    return origin[0] + x * S, origin[1] + y * S


def cursor(d, x, y, pressed=False):
    pts = [(0, 0), (0, 17), (4.5, 13), (7.5, 20), (10, 19), (7, 12), (12.5, 12)]
    k = 1.15
    d.polygon([(x + px * k, y + py * k) for px, py in pts], fill=(255, 255, 255), outline=(0, 0, 0))
    if pressed:
        d.ellipse([x - 13, y - 13, x + 13, y + 13], outline=(120, 170, 255), width=3)


def key_badge(img, text, alpha):
    if alpha <= 0:
        return
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = d.textlength(text, font=KEY) + 44
    x0, y0 = (W - w) / 2, H - 68
    d.rounded_rectangle([x0, y0, x0 + w, y0 + 52], 12, fill=(20, 22, 30, int(235 * alpha)), outline=(110, 120, 170, int(255 * alpha)), width=2)
    d.text((W / 2, y0 + 26), text, font=KEY, fill=(240, 242, 255, int(255 * alpha)), anchor='mm')
    img.paste(layer, (0, 0), layer)


def title(img, scene, alpha=1.0):
    name, sub = SCENES[scene]
    layer = Image.new('RGBA', img.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    d.text((W / 2, 38), name, font=TITLE, fill=(255, 255, 255, int(255 * alpha)), anchor='mm')
    d.text((W / 2, 72), sub, font=SUB, fill=(200, 205, 235, int(255 * alpha)), anchor='mm')
    img.paste(layer, (0, 0), layer)


def blend(a, b, t):
    return a if t <= 0 else b if t >= 1 else Image.blend(a, b, t)


def flying(t, reverse=False):
    """The 笔记 pane on its way between its column on the main screen and the second screen: it
    slides across at its own size, then opens up into the whole screen."""
    x, y, w, h = pane
    if reverse:
        t = 1 - t
    piece = small_pane
    a = (LEFT[0] + x * S, LEFT[1] + y * S)
    b = (RIGHT[0] + (MW - piece.width) / 2, RIGHT[1])
    e = ease(t / 0.6)
    at = (int(a[0] + (b[0] - a[0]) * e), int(a[1] + (b[1] - a[1]) * e))
    grow = ease((t - 0.6) / 0.4)
    if grow <= 0:
        return piece, at
    # Opening up: the second-screen capture is revealed through a widening window while the pane,
    # unstretched in the middle, fades out.
    w2 = int(piece.width + (MW - piece.width) * grow)
    img = small['s2'].crop(((MW - w2) // 2, 0, (MW + w2) // 2, MH))
    mid = (w2 - piece.width) // 2
    under = img.crop((mid, 0, mid + piece.width, MH))
    img.paste(blend(piece, under, grow), (mid, 0))
    return img, (RIGHT[0] + (MW - w2) // 2, RIGHT[1])


# Timeline (frames at 25 fps). Each entry draws one frame.
timeline = []


def hold(n, left, right, scene, **kw):
    for _ in range(n):
        timeline.append(dict(left=left, right=right, scene=scene, **kw))


def switch(frm, to, key):
    """Badge, then both screens cross-fade to the next scene."""
    n = 50
    for i in range(n):
        t = ease((i - 6) / 10)
        badge = min(1, i / 5, (n - i) / 8)
        timeline.append(dict(left=('mix', 'k' + frm, 'k' + to, t), right=('mix', 's' + frm, 's' + to, t), scene=('k' + to if t > 0.5 else 'k' + frm), badge=(key, badge)))


start_cur = (LEFT[0] + MW * 0.52, LEFT[1] + MH * 0.62)
btn = to_canvas(LEFT, *detach_btn)
hold(38, 'k1', 'wall', 'k1')
for i in range(20):  # cursor to the 笔记 pane's ⧉
    e = ease(i / 19)
    timeline.append(dict(left='k1', right='wall', scene='k1', cursor=(start_cur[0] + (btn[0] - start_cur[0]) * e, start_cur[1] + (btn[1] - start_cur[1]) * e, False)))
hold(6, 'k1', 'wall', 'k1', cursor=(btn[0], btn[1], True))
for i in range(26):  # the pane flies to the second screen
    t = i / 25
    timeline.append(dict(left=('mix', 'k1gap', 'k2', ease((t - 0.6) / 0.2)), right='wall', scene='k1', fly=(t, False)))
hold(40, 'k2', 's2', 'k2')
switch('2', '3', '→ 写论文')
hold(22, 'k3', 's3', 'k3')
switch('3', '4', '→ 做实验')
hold(22, 'k4', 's4', 'k4')
switch('4', '2', '→ 读论文')
hold(10, 'k2', 's2', 'k2')
sat_btn = to_canvas(RIGHT, SW - 20, 48)
from_cur = (RIGHT[0] + MW * 0.5, RIGHT[1] + MH * 0.55)
for i in range(16):  # cursor to the second screen's ⇱ (merge back)
    e = ease(i / 15)
    timeline.append(dict(left='k2', right='s2', scene='k2', cursor=(from_cur[0] + (sat_btn[0] - from_cur[0]) * e, from_cur[1] + (sat_btn[1] - from_cur[1]) * e, False)))
hold(6, 'k2', 's2', 'k2', cursor=(sat_btn[0], sat_btn[1], True))
for i in range(26):  # back into the main window
    t = i / 25
    timeline.append(dict(left=('mix', 'k2', 'k1gap', ease(t / 0.3)) if t < 0.95 else 'k1', right='wall', scene='k1', fly=(t, True)))
hold(14, 'k1', 'wall', 'k1')


def screen(spec):
    if spec == 'wall':
        return WALL
    if isinstance(spec, tuple):
        _, a, b, t = spec
        return blend(small[a], small[b], t)
    return small[spec]


for n, f in enumerate(timeline):
    img = BG.copy()
    img.paste(screen(f['left']), LEFT)
    img.paste(screen(f['right']), RIGHT)
    if 'fly' in f:
        piece, at = flying(*f['fly'])
        img.paste(piece, at)
    title(img, f['scene'])
    if 'badge' in f:
        key_badge(img, *f['badge'])
    if 'cursor' in f:
        cursor(ImageDraw.Draw(img), *f['cursor'])
    img.save(os.path.join(frames, f'{n:04d}.png'))
print(f'{len(timeline)} frames, {len(timeline) / FPS:.1f}s')
