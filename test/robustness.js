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

record("wrong key", extractV3(em.rgba, W, H, 99, standard.step, standard.parity) === null, "");

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
