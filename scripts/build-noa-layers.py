#!/usr/bin/env python3
"""Build public/models/noa from the Noa_Live2D_Prototype part layers (Source/layers.json + Source/layers/*.png).

Operator tool (needs Pillow). Image-only: no code from the prototype package is used. Steps, all reproducible:
  1. Repairs on the full 1200x1600 canvas: repaint the light neck patch under the chin (neck seam),
     remove light matting halos around the left hair, round the hoodie's rectangular top-left
     cut into a shoulder, feather its straight right-side cut.
  2. Derived expression parts from the existing art: a small "o" mouth (surprise) and a wavy mouth (troubled).
  3. Crop every layer to its opaque bounds and write model.json (canvas position, kind, side, pivot, draw order).
Usage: python3 scripts/build-noa-layers.py <path to Noa_Live2D_Prototype/Source> [out=public/models/noa]
"""
import json, math, os, sys
from PIL import Image, ImageFilter

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'public', 'models', 'noa')
W, H = 1200, 1600
meta = json.load(open(os.path.join(SRC, 'layers.json')))
layers = {l['name']: Image.open(os.path.join(SRC, l['file'])).convert('RGBA') for l in meta['layers']}
lum = lambda p: .299 * p[0] + .587 * p[1] + .114 * p[2]


def fix_neck_patch(body, x0=590, x1=820):
    """The body's neck top is a lighter skin patch with a hard horizontal edge where the chin used to be. Repaint the
    patch with the shadowed neck colour from just below that edge (the chin's shadow), keeping its alpha."""
    px = body.load()
    for x in range(x0, x1):
        col = [(y, px[x, y]) for y in range(700, 780) if px[x, y][3] > 200]
        if not col:
            continue
        # The edge: the first downward step where brightness drops sharply.
        edge = next((y for (y, p), (_, q) in zip(col, col[1:]) if lum(p) - lum(q) > 18), None)
        if edge is None:
            continue
        ref = px[x, min(H - 1, edge + 3)]
        for y in range(col[0][0], edge + 1):
            px[x, y] = (ref[0], ref[1], ref[2], px[x, y][3])


def remove_halo(im, box):
    """Matting halos: light, unsaturated pixels next to transparency (left over from a white background)."""
    px, alpha = im.load(), im.getchannel('A')
    near_clear = alpha.point(lambda v: 255 if v < 40 else 0).filter(ImageFilter.MaxFilter(5)).load()
    x0, y0, x1, y1 = box
    for y in range(y0, y1):
        for x in range(x0, x1):
            r, g, b, a = px[x, y]
            if a == 0 or not near_clear[x, y]:
                continue
            sat = max(r, g, b) - min(r, g, b)
            if lum((r, g, b)) > 95 and sat < 70:
                px[x, y] = (r, g, b, 0)
            elif a < 250:
                # Semi-transparent strand edge: pull its colour toward the dark hair so it cannot glow.
                px[x, y] = (min(r, 70), min(g, 72), min(b, 100), a)


def round_shoulder(im, x0=282, x1=472, top=840, drop=62):
    """The hoodie's top-left is a rectangular cut. Carve a rounded shoulder instead: clear everything above the curve
    y = top + drop * ((x1 - x) / (x1 - x0))^2 (only the hoodie band y >= top - 4; hair strands above stay), 2 px AA."""
    px = im.load()
    for x in range(x0 - 6, x1):
        u = max(0.0, min(1.0, (x1 - x) / (x1 - x0)))
        cut = top + drop * u * u
        for y in range(top - 4, int(cut) + 3):
            r, g, b, a = px[x, y]
            k = max(0.0, min(1.0, (y - cut + 2) / 2))
            px[x, y] = (r, g, b, int(a * k))


def feather_right_edge(im, y0, y1, width=18):
    px = im.load()
    for y in range(y0, y1):
        right = next((x for x in range(W - 1, -1, -1) if px[x, y][3] > 200), None)
        if right is None or right < 1086:   # only the straight vertical cut, not the natural hood outline
            continue
        for x in range(max(0, right - width), right + 1):
            r, g, b, a = px[x, y]
            px[x, y] = (r, g, b, int(a * (right - x) / width))


def o_mouth(open_mouth, pivot):
    """Surprise: the open mouth drawn small and round ("o"), centred on the mouth pivot."""
    box = open_mouth.getbbox()
    part = open_mouth.crop(box)
    w, h = part.size
    small = part.resize((max(8, int(w * .42)), max(8, int(h * .62))), Image.LANCZOS)
    out = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    out.paste(small, (int(pivot[0] - small.width / 2), int(pivot[1] - small.height / 2 + 6)), small)
    return out


def wave_mouth(closed, amp=2.2, droop=5.0):
    """Troubled: the closed mouth line bent into a small wave with lowered corners."""
    box = closed.getbbox()
    x0, x1 = box[0], box[2]
    src, out = closed.load(), Image.new('RGBA', (W, H), (0, 0, 0, 0))
    dst = out.load()
    for x in range(x0, x1):
        u = (x - x0) / max(1, x1 - x0 - 1)            # 0..1 across the mouth
        dy = amp * math.sin(u * 3 * math.pi) + droop * (2 * u - 1) ** 2
        for y in range(box[1], box[3]):
            p = src[x, y]
            if p[3]:
                ny = int(round(y + dy))
                if 0 <= ny < H:
                    dst[x, ny] = p
    return out


fix_neck_patch(layers['Body'])
for name in ('HeadBase', 'HairSideL'):
    remove_halo(layers[name], (140, 380, 560, 900))
round_shoulder(layers['Body'])
feather_right_edge(layers['Body'], 840, 1490)

by_name = {l['name']: l for l in meta['layers']}
mouth_pivot = by_name['MouthOpen']['pivot']
layers['MouthO'] = o_mouth(layers['MouthOpen'], mouth_pivot)
layers['MouthWave'] = wave_mouth(layers['MouthClosed'])
order = [l['name'] for l in meta['layers']]
i = order.index('MouthClosed') + 1
order[i:i] = ['MouthO', 'MouthWave']
extra = {'MouthO': {'kind': 'mouthO', 'defaultOpacity': 0, 'pivot': mouth_pivot},
         'MouthWave': {'kind': 'mouthWave', 'defaultOpacity': 0, 'pivot': by_name['MouthClosed']['pivot']}}

os.makedirs(OUT, exist_ok=True)
out = []
for name in order:
    im = layers[name]
    bb = im.getchannel('A').point(lambda v: 255 if v > 2 else 0).getbbox()
    c = im.crop(bb)
    cp = c.load()
    for y in range(c.height):
        for x in range(c.width):
            if cp[x, y][3] <= 2:
                cp[x, y] = (0, 0, 0, 0)
    c.save(os.path.join(OUT, f'{name}.png'), optimize=True)
    l = by_name.get(name, {}) | extra.get(name, {})
    e = {'name': name, 'file': f'{name}.png', 'kind': l['kind'], 'x': bb[0], 'y': bb[1], 'w': c.width, 'h': c.height, 'opacity': l.get('defaultOpacity', 1)}
    for k in ('side', 'pivot'):
        if k in l:
            e[k] = l[k]
    out.append(e)
json.dump({'name': 'Noa', 'canvas': [W, H], 'source': 'Noa_Live2D_Prototype v0.1 Source/layers (images only), repaired by scripts/build-noa-layers.py', 'layers': out},
          open(os.path.join(OUT, 'model.json'), 'w'), ensure_ascii=False, indent=1)
print(len(out), 'layers ->', OUT)
