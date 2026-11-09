/**
 * Robustness checks for the v3 blind watermark in index.html.
 * Needs Node and Pillow (python3 -c "import PIL").
 *
 *   node test/robustness.js
 *
 * Uses a deterministic textured image at 1178×496, the size from the
 * field report. JPEG sizes are whatever libjpeg produces for that image;
 * the interesting targets are ~19 KB and ~11 KB.
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");
const m = html.match(/<script id="yy-engine">([\s\S]*?)<\/script>/);
if (!m) throw new Error("engine script missing");
eval(m[1]);

const TEXT = "祀-盲水印测试-20261109";
const W = 1178, H = 496;

function photo(w, h) {
  const rng = mulberry32(11);
  const rgba = new Uint8ClampedArray(w * h * 4);
  const oct = [4, 8, 16, 32, 64, 128];
  const grids = oct.map((n) => {
    const gw = Math.ceil(w / n) + 2;
    const g = new Float64Array(gw * (Math.ceil(h / n) + 2));
    for (let i = 0; i < g.length; i++) g[i] = rng();
    return { n, g, gw };
  });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nse = 0, amp = 0.55;
      for (const { n, g, gw } of grids) {
        const fx = x / n, fy = y / n;
        const x0 = Math.floor(fx), y0 = Math.floor(fy);
        const ax = fx - x0, ay = fy - y0;
        const i00 = y0 * gw + x0;
        const v = (g[i00] * (1 - ax) + g[i00 + 1] * ax) * (1 - ay)
          + (g[i00 + gw] * (1 - ax) + g[i00 + gw + 1] * ax) * ay;
        nse += (v - 0.5) * amp;
        amp *= 0.55;
      }
      const hill = Math.sin(x * 0.01) * 28 + Math.sin(x * 0.003) * 40;
      const sky = y < h * 0.38;
      let r = (sky ? 150 : 90) + nse * 110;
      let g = (sky ? 170 : 120) + nse * 90;
      let b = (sky ? 200 : 70) + nse * 70;
      if (!sky && y > h * 0.55 + hill) { r += 20; g += 30; }
      if (Math.abs(y - (h * 0.62 + hill)) < 2) { r = 40; g = 36; b = 30; }
      const i = (y * w + x) * 4;
      rgba[i] = Math.max(0, Math.min(255, r));
      rgba[i + 1] = Math.max(0, Math.min(255, g));
      rgba[i + 2] = Math.max(0, Math.min(255, b));
      rgba[i + 3] = 255;
    }
  }
  return rgba;
}

const tmp = fs.mkdtempSync("/tmp/yy-robust-");
function jpegAt(rgba, w, h, q) {
  const raw = path.join(tmp, "in.raw");
  const jpg = path.join(tmp, "out.jpg");
  const out = path.join(tmp, "out.raw");
  fs.writeFileSync(raw, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  const r = spawnSync("python3", ["-c", `
from PIL import Image
import sys, os
w,h,q=map(int,sys.argv[1:4])
im=Image.frombytes("RGBA",(w,h),open(${JSON.stringify(raw)},"rb").read()).convert("RGB")
im.save(${JSON.stringify(jpg)},"JPEG",quality=q,subsampling=2,optimize=True)
open(${JSON.stringify(out)},"wb").write(Image.open(${JSON.stringify(jpg)}).convert("RGBA").tobytes())
print(os.path.getsize(${JSON.stringify(jpg)}))
`, String(w), String(h), String(q)], { encoding: "utf8" });
  if (r.status) throw new Error(r.stderr || "jpeg failed");
  const b = fs.readFileSync(out);
  return { rgba: new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength), bytes: +r.stdout.trim() };
}
function closestJpeg(rgba, w, h, target) {
  let best = null;
  for (let q = 5; q <= 30; q++) {
    const j = jpegAt(rgba, w, h, q);
    const d = Math.abs(j.bytes - target);
    if (!best || d < best.d) best = { d, q, ...j };
  }
  return best;
}
function geom(rgba, w, h, k) {
  const raw = path.join(tmp, "in.raw");
  const out = path.join(tmp, "atk.rgba");
  fs.writeFileSync(raw, Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
  const r = spawnSync("python3", ["-c", `
from PIL import Image
im=Image.frombytes("RGBA",(${w},${h}),open(${JSON.stringify(raw)},"rb").read()).convert("RGB")
k=${JSON.stringify(k)}
if k=="cropback":
    x0,y0=round(im.width*0.1),round(im.height*0.1)
    c=im.crop((x0,y0,im.width-x0,im.height-y0)).resize(im.size, Image.Resampling.BICUBIC)
elif k=="cropsmall":
    x0,y0=round(im.width*0.1),round(im.height*0.1)
    c=im.crop((x0,y0,im.width-x0,im.height-y0)).resize((800,337), Image.Resampling.BICUBIC)
elif k=="rot15":
    c=im.rotate(15, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(255,255,255))
elif k=="rot15same":
    c=im.rotate(15, resample=Image.Resampling.BICUBIC, expand=False, fillcolor=(255,255,255))
elif k=="scale50":
    c=im.resize((max(2,im.width//2), max(2,im.height//2)), Image.Resampling.BICUBIC)
elif k=="flip":
    c=im.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
elif k=="rot90":
    c=im.transpose(Image.Transpose.ROTATE_90)
elif k=="shot":
    c=im.resize((786,331), Image.Resampling.BICUBIC)
elif k.startswith("phone"):
    # 手机截屏：图按比例缩到 r 宽，贴在纯色画布中间，上方有状态栏，图右上角压一个半透明按钮，底部黑边上有点赞评论按钮
    from PIL import ImageDraw
    _, r, bg = k.split(":")
    r = float(r)
    dw = round(im.width * r); dh = round(im.height * dw / im.width)
    cw, ch = dw, round(dw * 2.17)
    col = (0, 0, 0) if bg == "black" else (255, 255, 255)
    fg = (255, 255, 255, 255) if bg == "black" else (20, 20, 20, 255)
    c = Image.new("RGB", (cw, ch), col)
    top = (ch - dh) // 2
    c.paste(im.resize((dw, dh), Image.Resampling.LANCZOS), (0, top))
    d = ImageDraw.Draw(c, "RGBA")
    d.text((16, 10), "18:23", fill=fg)
    d.rectangle((cw - 50, 12, cw - 18, 22), fill=fg)
    bx, by = cw - int(cw * 0.22), top + int(cw * 0.03)
    d.rounded_rectangle((bx, by, bx + int(cw * 0.19), by + int(cw * 0.065)), radius=int(cw * 0.03), fill=(30, 30, 30, 150))
    d.text((bx + 8, by + 4), "AI", fill=(255, 255, 255, 255))
    yb = ch - int(ch * 0.09)
    for i in range(4):
        x = int(cw * (0.1 + 0.22 * i))
        d.ellipse((x, yb, x + int(cw * 0.07), yb + int(cw * 0.07)), outline=fg, width=2)
    d.text((16, ch - int(ch * 0.16)), "@user  1234", fill=fg)
elif k=="crop2":
    x0,y0=round(im.width*0.02),round(im.height*0.02)
    c=im.crop((x0,y0,im.width-x0,im.height-y0))
elif k=="aniso":
    c=im.resize((im.width, round(im.height*0.7)), Image.Resampling.BICUBIC)
elif k in ("social","rot2crop"):
    import io
    if k=="social":
        x0,y0=round(im.width*0.05),round(im.height*0.05)
        c=im.crop((x0,y0,im.width-x0,im.height-y0)); c=c.resize((1000, round(c.height*1000/c.width)), Image.Resampling.LANCZOS); q=75
    else:
        c=im.rotate(2, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(255,255,255))
        x0,y0=round(c.width*0.05),round(c.height*0.05); c=c.crop((x0,y0,c.width-x0,c.height-y0)); q=70
    b=io.BytesIO(); c.save(b,"JPEG",quality=q); b.seek(0); c=Image.open(b).convert("RGB")
elif k=="border":
    from PIL import ImageOps
    c=ImageOps.expand(im,border=40,fill=(128,128,128))
elif k=="rot30":
    c=im.rotate(30, resample=Image.Resampling.BICUBIC, expand=True, fillcolor=(255,255,255))
elif k=="persp2":
    import numpy as np
    w,h=im.size; d=0.02*w
    src=[(0,0),(w,0),(w,h),(0,h)]; dst=[(d,d*0.5),(w-d*0.3,0),(w,h),(d*0.2,h-d*0.4)]
    A=[];B=[]
    for (x,y),(X,Y) in zip(dst,src):
        A.append([x,y,1,0,0,0,-X*x,-X*y]);B.append(X)
        A.append([0,0,0,x,y,1,-Y*x,-Y*y]);B.append(Y)
    co=np.linalg.solve(np.array(A,float),np.array(B,float))
    c=im.transform(im.size,Image.Transform.PERSPECTIVE,tuple(co),Image.Resampling.BICUBIC,fillcolor=(255,255,255))
elif k in ("bright","darker","contrast06","gamma06","gamma18","invert","hue90"):
    from PIL import ImageEnhance, ImageOps
    if k=="bright": c=ImageEnhance.Brightness(im).enhance(1.2)
    elif k=="darker": c=ImageEnhance.Brightness(im).enhance(0.7)
    elif k=="contrast06": c=ImageEnhance.Contrast(im).enhance(0.6)
    elif k=="gamma06": c=im.point(lambda v: round(255*(v/255)**0.6))
    elif k=="gamma18": c=im.point(lambda v: round(255*(v/255)**1.8))
    elif k=="invert": c=ImageOps.invert(im)
    else:
        hh,ss,vv=im.convert("HSV").split(); hh=hh.point(lambda x:(x+64)%256); c=Image.merge("HSV",(hh,ss,vv)).convert("RGB")
else:
    raise SystemExit("bad "+k)
open(${JSON.stringify(out)},"wb").write(c.convert("RGBA").tobytes())
print(c.size[0], c.size[1])
`], { encoding: "utf8" });
  if (r.status) throw new Error(r.stderr || r.stdout);
  const [aw, ah] = r.stdout.trim().split(/\s+/).map(Number);
  const b = fs.readFileSync(out);
  return { rgba: new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength), w: aw, h: ah };
}

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  " + detail : ""}`);
}

function loadPhoto() {
  const jpg = path.join(tmp, "src.jpg");
  const raw = path.join(tmp, "src.rgba");
  const dl = spawnSync("curl", ["-fsSL", "-o", jpg, "https://upload.wikimedia.org/wikipedia/commons/thumb/3/3f/Fronalpstock_big.jpg/1280px-Fronalpstock_big.jpg"]);
  if (dl.status !== 0) return photo(W, H);
  const r = spawnSync("python3", ["-c", `
from PIL import Image
im=Image.open(${JSON.stringify(jpg)}).convert("RGB").resize((${W},${H}), Image.Resampling.LANCZOS)
open(${JSON.stringify(raw)},"wb").write(im.convert("RGBA").tobytes())
`], { encoding: "utf8" });
  if (r.status) return photo(W, H);
  const b = fs.readFileSync(raw);
  return new Uint8ClampedArray(b.buffer, b.byteOffset, b.byteLength);
}

const src = loadPhoto();
const standard = { step: 12, parity: 20, d1: 36, d2: 20 };
const robust = { step: 20, parity: 32, d1: 48, d2: 28 };
console.log("embedding standard…");
const em = embedV3(src, W, H, TEXT, 1, standard.step, standard.parity);
console.log(`psnr ${em.psnr.toFixed(2)}  max Δ ${em.maxd.toFixed(1)}`);

function check(img, tag, opt) {
  const known = opt && opt.known === null ? null : [W, H];
  const step = (opt && opt.step) || standard.step;
  const parity = (opt && opt.parity) || standard.parity;
  const password = opt && opt.password != null ? opt.password : 1;
  const t0 = Date.now();
  const r = recoverWatermark(img, {
    password, step, parity, d1: standard.d1, d2: standard.d2,
    fast: false, known, legacyLen: 0, deep: true,
  });
  const ok = !!(r && r.text === TEXT);
  record(tag, ok, `${Date.now() - t0}ms ${r && r.note ? r.note : ""}`.trim());
}

check({ rgba: em.rgba, w: W, h: H }, "png");
for (const q of [80, 50]) {
  const j = jpegAt(em.rgba, W, H, q);
  check({ rgba: j.rgba, w: W, h: H }, `jpeg q${q} (${Math.round(j.bytes / 1024)} KB)`);
}
const j19 = closestJpeg(em.rgba, W, H, 19 * 1024);
check({ rgba: j19.rgba, w: W, h: H }, `jpeg ~19KB q${j19.q} (${Math.round(j19.bytes / 1024)} KB)`);
const j11 = closestJpeg(em.rgba, W, H, 11 * 1024);
{
  const r = recoverWatermark({ rgba: j11.rgba, w: W, h: H }, {
    password: 1, step: standard.step, parity: standard.parity, d1: standard.d1, d2: standard.d2,
    fast: false, known: [W, H], legacyLen: 0, deep: true,
  });
  const hit = !!(r && r.text === TEXT);
  // 标准不保证质量约 10。记下结果，不把它当成失败。
  record(`jpeg ~11KB q${j11.q} (${Math.round(j11.bytes / 1024)} KB) standard`, true, hit ? "survived" : "miss (预期，请用强)");
}

console.log("embedding strong…");
const emS = embedV3(src, W, H, TEXT, 1, robust.step, robust.parity);
const j11s = closestJpeg(emS.rgba, W, H, 11 * 1024);
{
  const t0 = Date.now();
  const r = recoverWatermark({ rgba: j11s.rgba, w: W, h: H }, {
    password: 1, step: robust.step, parity: robust.parity, d1: robust.d1, d2: robust.d2,
    fast: false, known: [W, H], legacyLen: 0, deep: true,
  });
  record(`jpeg ~11KB q${j11s.q} (${Math.round(j11s.bytes / 1024)} KB) strong  psnr ${emS.psnr.toFixed(1)}`, !!(r && r.text === TEXT), `${Date.now() - t0}ms`);
}

for (const k of ["scale50", "shot", "flip", "rot90", "cropback", "cropsmall", "rot15", "rot15same"]) {
  const g = geom(em.rgba, W, H, k);
  check(g, `${k} ${g.w}×${g.h}`);
}
// rotation without the original size filled in
{
  const g = geom(em.rgba, W, H, "rot15");
  const t0 = Date.now();
  const r = recoverWatermark(g, {
    password: 1, step: standard.step, parity: standard.parity, d1: 36, d2: 20,
    fast: false, known: null, legacyLen: 0, deep: true,
  });
  record("rot15 without original size", !!(r && r.text === TEXT), `${Date.now() - t0}ms ${r && r.note ? r.note : ""}`.trim());
}
{
  const g = geom(em.rgba, W, H, "shot");
  check(g, "shot without original size", { known: null });
}

// 手机截屏：上下纯色边、缩小、UI 按钮压在图上，有时再存成 JPEG
function jpegOf(g, q) {
  const j = jpegAt(g.rgba, g.w, g.h, q);
  return { rgba: j.rgba, w: g.w, h: g.h };
}
for (const [k, q, known] of [
  ["phone:0.4:black", 0, true], ["phone:0.4:black", 0, false], ["phone:0.4:black", 85, false],
  ["phone:0.3:black", 0, true], ["phone:0.3:black", 85, false], ["phone:1:black", 90, false],
  ["phone:0.44:white", 0, false],
]) {
  let g = geom(em.rgba, W, H, k);
  if (q) g = jpegOf(g, q);
  check(g, `screenshot ${k.slice(6)} ${g.w}×${g.h}${q ? " jpeg q" + q : ""}${known ? "" : " without original size"}`, known ? undefined : { known: null });
}
// 大片接近纯白的图：写入时要按截断后的亮度去凑目标，否则这些块一开始就是错的
{
  const bright = new Uint8ClampedArray(src);
  for (let i = 0; i < bright.length; i += 4) for (let c = 0; c < 3; c++) bright[i + c] = Math.min(255, src[i + c] * 0.35 + 175);
  const eb = embedV3(bright, W, H, TEXT, 1, standard.step, standard.parity);
  record("bright image png", extractV3(eb.rgba, W, H, 1, standard.step, standard.parity) === TEXT, "");
  const g = jpegOf(geom(eb.rgba, W, H, "phone:0.4:black"), 85);
  const t0 = Date.now();
  const r = recoverWatermark(g, {
    password: 1, step: standard.step, parity: standard.parity, d1: standard.d1, d2: standard.d2,
    fast: false, known: null, legacyLen: 0, deep: true,
  });
  record(`bright image screenshot 0.4 jpeg q85 without original size`, !!(r && r.text === TEXT), `${Date.now() - t0}ms ${r && r.note ? r.note : ""}`.trim());
}

// 通用几何找回：裁一点、不等比缩放、转发链路、旋转加裁边、灰边、大角度旋转、轻透视，都不填原尺寸
for (const k of ["crop2", "aniso", "social", "rot2crop", "border", "rot30", "persp2"]) {
  const g = geom(em.rgba, W, H, k);
  check(g, `${k} ${g.w}×${g.h} without original size`, { known: null });
}
// 调色：亮度、对比度、伽马、反色、色相
for (const k of ["bright", "darker", "contrast06", "gamma06", "gamma18", "invert", "hue90"]) {
  const g = geom(em.rgba, W, H, k);
  check(g, `tone ${k}`, { known: null });
}
// 旧版（向下取整选格点）写入的图仍能读，包括深度找回
function embedV3Legacy(rgba, w, h, text, password, step, parity) {
  const bits = bytesToBits(v3Codeword(text, parity));
  const B = 16, n = Math.floor(w / B) * Math.floor(h / B);
  const order = Array.from({ length: n }, (_, i) => i);
  shuffleInPlace(order, password >>> 0);
  const sb = shuffledBits(bits, (password + 0x9e3779b9) >>> 0);
  const Y = new Float64Array(w * h);
  v3Luma(rgba, Y);
  const { m } = v3BoxMeans(Y, w, h, B);
  const inv = new Int32Array(n);
  for (let k = 0; k < n; k++) inv[order[k]] = k;
  const target = new Float64Array(n);
  for (let bi = 0; bi < n; bi++) {
    let t = (Math.floor(m[bi] / step) + 0.25 + 0.5 * sb[inv[bi] % sb.length]) * step;
    if (t > 251) t -= step; else if (t < 4) t += step;
    target[bi] = t;
  }
  const field = v3ApplyTargets(Y, w, h, B, target, rgba);
  const out = new Uint8ClampedArray(rgba);
  for (let i = 0; i < w * h; i++) { out[i * 4] += field[i]; out[i * 4 + 1] += field[i]; out[i * 4 + 2] += field[i]; }
  return out;
}
{
  const old = embedV3Legacy(src, W, H, TEXT, 1, standard.step, standard.parity);
  record("legacy-lattice v3 png", extractV3(old, W, H, 1, standard.step, standard.parity) === TEXT, "");
  check(jpegOf({ rgba: old, w: W, h: H }, 75), "legacy-lattice v3 jpeg q75", { known: null });
  check(geom(old, W, H, "crop2"), "legacy-lattice v3 crop2 without original size", { known: null });
  check(geom(old, W, H, "gamma06"), "legacy-lattice v3 gamma 0.6", { known: null });
  console.log(`psnr new ${em.psnr.toFixed(2)}`);
}

record("wrong key", extractV3(em.rgba, W, H, 99, standard.step, standard.parity) === null, "");
// 深度找回用错密钥也不能读出东西（几何、调色搜索都不该误报）
for (const k of ["rot2crop", "gamma06"]) {
  const g = geom(em.rgba, W, H, k);
  const r = recoverWatermark(g, { password: 99, step: standard.step, parity: standard.parity, d1: standard.d1, d2: standard.d2, fast: false, known: null, legacyLen: 0, deep: true });
  record(`wrong key deep ${k}`, !r, r ? r.text : "");
}

// legacy v2 still extracts
{
  const bits = frameBitsFor(TEXT);
  const leg = embedWatermark({ rgba: src, width: W, height: H, bits, passwordImg: 1, passwordWm: 1, d1: 36, d2: 20, fast: false });
  const fr = extractFrame({ rgba: leg.rgba, width: W, height: H, passwordImg: 1, passwordWm: 1, d1: 36, d2: 20, fast: false }, 0, 3);
  record("legacy v2 png", !!(fr && fr.text === TEXT), "");
  const j = jpegAt(leg.rgba, W, H, 50);
  const fr2 = extractFrame({ rgba: j.rgba, width: W, height: H, passwordImg: 1, passwordWm: 1, d1: 36, d2: 20, fast: false }, 0, 3);
  record("legacy v2 jpeg q50", !!(fr2 && fr2.text === TEXT), `${Math.round(j.bytes / 1024)} KB`);
}

// second write replaces the readable payload
{
  const second = embedV3(em.rgba, W, H, "覆盖测试-ABC", 1, standard.step, standard.parity);
  const got = extractV3(second.rgba, W, H, 1, standard.step, standard.parity);
  record("second write returns new text", got === "覆盖测试-ABC", got || "");
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
if (failed.length) {
  console.log("failed:", failed.map((f) => f.name).join(", "));
  process.exit(1);
}
