# Offline asset prep. Run manually: python -I scripts/prep-assets.py
# Reads brand/LOGO UNCEX PNG...png (RGBA, colortype 6, pure-black transparent region),
# derives palette (k-means, snapped to real pixel coords), premultiplied resizes, favicon trace.
import json, os
import numpy as np
from PIL import Image
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = Image.open(os.path.join(R, "brand", "LOGO UNCEX PNG...png")).convert("RGBA")
a = np.array(src).astype(np.float64)
alpha = a[..., 3]
ys, xs = np.where(alpha > 0)
x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
print("bbox", x0, y0, x1, y1)
# --- palette: k-means (k=6, fixed seed) over fully opaque pixels, snapped to nearest real pixel
op = a[(alpha == 255)][:, :3]
rng = np.random.default_rng(7)
sample = op[rng.choice(len(op), 60000, replace=False)]
k = 6
cent = sample[rng.choice(len(sample), k, replace=False)]
for _ in range(40):
    d = ((sample[:, None, :] - cent[None]) ** 2).sum(2)
    lab = d.argmin(1)
    for i in range(k):
        if (lab == i).any():
            cent[i] = sample[lab == i].mean(0)
H, W = alpha.shape
full = np.array(src)[..., :3].astype(np.float64)
pal = []
opmask = (alpha == 255)
oy, ox = np.where(opmask)
opc = full[oy, ox]
for i in range(k):
    j = ((opc - cent[i]) ** 2).sum(1).argmin()
    rgb = tuple(int(v) for v in opc[j])
    cnt = int((lab == i).sum())
    pal.append({"hex": "#%02X%02X%02X" % rgb, "x": int(ox[j]), "y": int(oy[j]), "share": round(cnt / len(lab), 4)})
pal.sort(key=lambda p: -p["share"])
print(json.dumps(pal, indent=1))
json.dump(pal, open(os.path.join(R, "scripts", "palette.json"), "w"), indent=1)

# --- premultiplied resize (transparent region is pure black: straight resize would bleed black halos)
def premul_resize(img, size):
    arr = np.array(img).astype(np.float64) / 255.0
    arr[..., :3] *= arr[..., 3:4]
    im = Image.fromarray((arr * 255).round().astype(np.uint8), "RGBA")
    # resize channels as float via PIL 'F'
    chans = [Image.fromarray(arr[..., c].astype(np.float32), "F").resize(size, Image.LANCZOS) for c in range(4)]
    o = np.stack([np.array(c) for c in chans], -1)
    al = np.clip(o[..., 3], 0, 1)
    rgb = np.where(al[..., None] > 1e-6, o[..., :3] / np.maximum(al[..., None], 1e-6), 0)
    out = np.concatenate([np.clip(rgb, 0, 1), al[..., None]], -1)
    return Image.fromarray((out * 255).round().astype(np.uint8), "RGBA")
pad = 24
crop = src.crop((max(0, x0 - pad), max(0, y0 - pad), min(W, x1 + pad), min(H, y1 + pad)))
cw, ch = crop.size
for h in (96, 192, 512):
    w = round(cw * h / ch)
    premul_resize(crop, (w, h)).save(os.path.join(R, "src", "assets", "logo-%d.png" % h), optimize=True)
    print("logo", h, w)
premul_resize(src.crop((x0, y0, x1, y1)), (180, round(180 * (y1 - y0) / (x1 - x0)))).save(os.path.join(R, "src", "assets", "apple-touch-icon-raw.png"))

# --- favicon: trace 32x32 grid from the real pixel grid (box-averaged cells, snapped to palette)
side = max(x1 - x0, y1 - y0)
cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
g = 32
inner = 28
cell = side / inner
palrgb = np.array([[int(p["hex"][i:i + 2], 16) for i in (1, 3, 5)] for p in pal], float)
rects = []
for gy in range(inner):
    for gx in range(inner):
        sx0 = int(cx - side / 2 + gx * cell); sx1 = int(cx - side / 2 + (gx + 1) * cell)
        sy0 = int(cy - side / 2 + gy * cell); sy1 = int(cy - side / 2 + (gy + 1) * cell)
        blk = a[sy0:sy1, sx0:sx1]
        al = blk[..., 3]
        if al.mean() < 128: continue
        m = al > 200
        if not m.any(): continue
        col = blk[m][:, :3].mean(0)
        idx = ((palrgb - col) ** 2).sum(1).argmin()
        rects.append((gx + 2, gy + 2, pal[idx]["hex"]))
# merge horizontal runs
rows = {}
for x, y, c in rects: rows.setdefault(y, []).append((x, c))
parts = []
for y in sorted(rows):
    r = sorted(rows[y]); i = 0
    while i < len(r):
        j = i
        while j + 1 < len(r) and r[j + 1][0] == r[j][0] + 1 and r[j + 1][1] == r[i][1]: j += 1
        parts.append('<rect x="%d" y="%d" width="%d" height="1" fill="%s"/>' % (r[i][0], y, j - i + 1, r[i][1]))
        i = j + 1
svg = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32" shape-rendering="crispEdges">' + "".join(parts) + "</svg>"
assert "--" not in svg
open(os.path.join(R, "src", "favicon.svg"), "w").write(svg)
print("favicon bytes", len(svg), "rects", len(parts))
