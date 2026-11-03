// The skinned windows: a classic .wsz skin, converted by skin.py, drawn sprite by sprite at the classic
// coordinates (main window 275x116, equalizer below). Every sprite is a window onto its pre-scaled sheet.
// ponytail: sheets are pre-scaled for a 2x (retina) screen; a 1x screen would need @1 sheets.

import { div, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { readTextFile, home } from "herdr";
import { VIS_MODES, EQ_PRESETS } from "./panels.js";

export async function loadSkin(dir) {
  const text = await readTextFile(`${dir}/manifest.json`).catch(() => null);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// text.bmp: 5x6 glyphs, row 0 letters, row 1 digits and punctuation, row 2 a few accents (Webamp's lookup).
const FONT = {};
[..."abcdefghijklmnopqrstuvwxyz\"@"].forEach((c, i) => { FONT[c] = [0, i]; });
[..."0123456789"].forEach((c, i) => { FONT[c] = [1, i]; });
[..."….:()-'!_+\\/[]^&%,=$#"].forEach((c, i) => { FONT[c] = [1, 10 + i]; });
Object.assign(FONT, { "å": [2, 0], "ö": [2, 1], "ä": [2, 2], "?": [2, 3], "*": [2, 4], "<": [1, 22], ">": [1, 23], "{": [1, 22], "}": [1, 23] });
const glyphOf = (c) => FONT[c] ?? FONT[c.normalize("NFD").replace(/[̀-ͯ]/g, "")] ?? [0, 30];

const stop = (_e, cx) => cx.stop_propagation();
const hex = (rgb) => `#${(rgb ?? [0, 0, 0]).map((v) => v.toString(16).padStart(2, "0")).join("")}`;

// Drawing helpers for one skin at one scale.
function painter(sk, S) {
  const sheet = (name) => sk.sheets[name] ?? (name === "nums_ex" ? null : null);
  // The sprite at (sx, sy) w×h of a sheet, as a block (no position).
  const cut = (name, sx, sy, w, h) => {
    const m = sheet(name);
    const box = div().w(w * S).h(h * S).flex_none().overflow_hidden().relative();
    return m ? box.child(image(`${sk.path}/${name}@${2 * S}.png`).absolute().left(-sx * S).top(-sy * S).w(m.w * S).h(m.h * S)) : box;
  };
  // …placed at (x, y) in the window.
  const at = (el, x, y) => el.absolute().left(x * S).top(y * S);
  const sprite = (name, sx, sy, w, h, x, y) => at(cut(name, sx, sy, w, h), x, y);
  const text = (str, max) => h_flex().children([...String(str).toLowerCase()].slice(0, max ?? 999).map((c) => {
    const [r, col] = glyphOf(c);
    return cut("text", col * 5, r * 6, 5, 6);
  }));
  return { cut, at, sprite, text };
}

export function skinnedMain(p, sk) {
  const S = p.set.scale, { cut, at, sprite, text } = painter(sk, S), s = p.state, set = p.set;
  // A button: its sprite, the pressed one while held, and what a click does.
  const button = (id, name, n, d, w, h, x, y, fn, label) => at(cut(name, ...(p.pressed === id ? d : n), w, h), x, y).id(id)
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); p.pressed = id; cx.notify(); })
    .on_click((_e, cx) => fn(cx)).role("button").accessibility_label(label);
  // A clickable area with no sprite of its own (it's painted into main.bmp).
  const area = (id, x, y, w, h, fn, label) => div().id(id).absolute().left(x * S).top(y * S).w(w * S).h(h * S)
    .on_mouse_down("left", stop).on_click((_e, cx) => fn(cx)).role("button").accessibility_label(label);
  const nextVis = (cx) => p.audio({ vis: VIS_MODES[(VIS_MODES.indexOf(set.vis) + 1) % VIS_MODES.length] }, cx);
  const close = button("close", "titlebar", [18, 0], [18, 9], 9, 9, 264, 3, () => p.closeWindow(), "Close player, stopping the music");
  const shadeBtn = (unshade) => button("shade", "titlebar", unshade ? [0, 27] : [0, 18], unshade ? [9, 27] : [9, 18], 9, 9, 254, 3,
    (cx) => p.save({ shade: !set.shade }, cx), unshade ? "Restore" : "Shade");
  const minimize = button("minimize", "titlebar", [9, 0], [9, 9], 9, 9, 244, 3, (cx) => p.save({ shade: !set.shade }, cx), "Shade");
  const clock = set.remaining && s.length > 0 && s.time >= 0 ? s.length - s.time : s.time;

  if (set.shade) {
    const mm = clock >= 0 ? `${String(Math.floor(clock / 60)).padStart(2, "0")}:${String(Math.floor(clock % 60)).padStart(2, "0")}` : "     ";
    return div().id("skin-shade").relative().w(275 * S).h(14 * S)
      .child(sprite("titlebar", 27, 29, 275, 14, 0, 0))
      .child(at(text(`${set.remaining && clock >= 0 ? "-" : ""}${mm}`), 127, 4))
      .child(minimize).child(shadeBtn(true)).child(close);
  }

  // Time: nums_ex has a minus sign; numbers.bmp only a 5x1 dash at (20, 6).
  const nums = sk.sheets.nums_ex ? "nums_ex" : "numbers";
  const digit = (d, x) => sprite(nums, d * 9, 0, 9, 13, x, 26);
  const t = Math.max(0, Math.floor(clock));
  const digits = clock >= 0 ? [Math.floor(t / 600) % 10, Math.floor(t / 60) % 10, Math.floor((t % 60) / 10), t % 10] : null;

  // The marquee scrolls a title wider than its 154 px back and forth, natively.
  const title = (s.title || "herdr-player").replace(/\s+/g, " ");
  const label = `${title}${s.length > 0 ? ` (${Math.floor(s.length / 60)}:${String(Math.floor(s.length % 60)).padStart(2, "0")})` : ""}`;
  const over = label.length * 5 - 154;
  const marquee = at(div().id("marquee").w(154 * S).h(6 * S).overflow_hidden().relative()
    .child(div().id(`mq-${label}`).absolute().left(0).top(0)
      .when(over > 0 && s.playing, (el) => el.loop("left", { from: 0, to: -over * S, period: Math.max(2000, label.length * 200), easing: "linear" }))
      .child(text(label))), 111, 27);

  // Visualizer: bars are the skin's gradient under a cover of the background colour that moves (motion only:
  // mpv hands out no spectrum). The meter covers two wide bars by mpv's live left and right levels.
  const bg = hex(sk.viscolor?.[0]);
  const visBar = (id, x, w, cover) => at(div().id(id).w(w * S).h(16 * S).relative().overflow_hidden()
    .child(sk.sheets.visbar ? image(`${sk.path}/visbar@${2 * S}.png`).absolute().left(0).top(0).w(w * S).h(16 * S) : div())
    .child(cover(div().absolute().left(0).top(0).w(w * S).bg(bg))), x, 43);
  const vis = set.vis === "bars"
    ? Array.from({ length: 19 }, (_, i) => visBar(`vb-${i}`, 24 + i * 4, 3, (c) => s.playing
      ? c.h(14 * S).loop("height", { from: 14 * S, to: (12 - ((i * 7) % 11)) * S, period: 380 + ((i * 97) % 520) })
      : c.h(16 * S)))
    : set.vis === "meter"
      ? p.levels.map((lv, i) => visBar(`vm-${i}`, 24 + i * 39, 37, (c) => c.h(Math.round((1 - lv) * 16) * S).transition("height", 120)))
      : [];

  const seekFrac = p.drag?.kind === "seek" ? p.drag.frac : s.length > 0 ? s.time / s.length : 0;
  const vol = p.drag?.kind === "vol" ? p.drag.frac * 100 : s.volume;
  const bal = p.drag?.kind === "bal" ? p.drag.frac * 2 - 1 : set.balance;
  const volFrame = Math.round(vol * 27 / 100), balFrame = Math.round(Math.abs(bal) * 27);
  const thumb = (name, id, x) => sprite(name, p.drag?.kind === id ? 0 : 15, 422, 14, 11, x, 58);
  const track = (id, x, y, w, h, apply) => div().id(`${id}-track`).absolute().left(x * S).top(y * S).w(w * S).h(h * S)
    .on_mouse_down("left", (e, cx) => p.startDrag(id, e, apply, cx));
  const on = (b) => b;
  const sh = set.shuffle, rp = set.repeat, eq = set.eqOpen, pl = set.plOpen;

  return div().id("skin-main").relative().w(275 * S).h(116 * S)
    .child(sprite("main", 0, 0, 275, 116, 0, 0))
    .child(sprite("titlebar", 27, 0, 275, 14, 0, 0))
    // Title bar: the options button opens the skin store; minimize and shade fold the window to a strip.
    .child(button("options", "titlebar", [0, 0], [0, 9], 9, 9, 6, 3, () => p.openStore(), "Skin store"))
    .child(minimize).child(shadeBtn(false)).child(close)
    // Clutter bar: O next skin, I skin store, D double size, V visualizer.
    .child(sprite("titlebar", 304, 0, 8, 43, 10, 22))
    .child(area("clutter-o", 10, 25, 8, 8, (cx) => p.nextSkin(cx), "Next skin"))
    .child(area("clutter-i", 10, 40, 8, 7, () => p.openStore(), "Skin store"))
    .child(area("clutter-d", 10, 47, 8, 8, (cx) => p.save({ scale: S === 1 ? 2 : 1 }, cx), "Double size"))
    .child(area("clutter-v", 10, 55, 8, 7, nextVis, "Change visualizer"))
    // Display.
    .child(sprite("playpaus", s.playing ? 0 : s.paused ? 9 : 18, 0, 9, 9, 26, 28))
    .when(set.remaining && clock >= 0, (el) => el.child(nums === "nums_ex" ? sprite(nums, 99, 0, 9, 13, 36, 26) : sprite(nums, 20, 6, 5, 1, 39, 32)))
    .when(Boolean(digits), (el) => el.child(digit(digits[0], 48)).child(digit(digits[1], 60)).child(digit(digits[2], 78)).child(digit(digits[3], 90)))
    .child(area("time", 36, 26, 63, 13, (cx) => p.save({ remaining: !set.remaining }, cx), "Elapsed or remaining time"))
    .children(vis)
    .child(area("vis", 24, 43, 76, 16, nextVis, "Change visualizer"))
    .child(marquee)
    .when(s.kbps > 0, (el) => el.child(at(text(String(Math.min(999, s.kbps)).padStart(3, " ")), 111, 43)))
    .when(s.khz > 0, (el) => el.child(at(text(String(Math.min(99, s.khz)).padStart(2, " ")), 156, 43)))
    .child(sprite("monoster", 29, s.channels === 1 ? 0 : 12, 27, 12, 212, 41))
    .child(sprite("monoster", 0, s.channels >= 2 ? 0 : 12, 29, 12, 239, 41))
    // Volume and balance: the frame follows the value, the thumb slides.
    .child(sprite("volume", 0, volFrame * 15, 68, 13, 107, 57))
    .child(thumb("volume", "vol", 107 + Math.round(vol / 100 * 54)))
    .child(track("vol", 107, 57, 68, 13, (f, done, cx) => { p.state.volume = Math.round(f * 100); if (done) p.volume(f * 100, cx); }))
    .child(sprite("balance", 9, balFrame * 15, 38, 13, 177, 57))
    .child(thumb("balance", "bal", 177 + Math.round((bal + 1) / 2 * 24)))
    .child(track("bal", 177, 57, 38, 13, (f, done, cx) => {
      const b = Math.abs(f * 2 - 1) < 0.08 ? 0 : f * 2 - 1;
      p.set.balance = b;
      if (done) p.audio({ balance: b }, cx);
    }))
    // EQ and playlist toggles.
    .child(button("eq", "shufrep", [0, on(eq) ? 73 : 61], [46, on(eq) ? 73 : 61], 23, 12, 219, 58, (cx) => p.save({ eqOpen: !eq }, cx), "Equalizer"))
    .child(button("pl", "shufrep", [23, on(pl) ? 73 : 61], [69, on(pl) ? 73 : 61], 23, 12, 242, 58, (cx) => p.save({ plOpen: !pl }, cx), "Playlist"))
    // Seek bar: the thumb only shows while there's something to seek.
    .child(sprite("posbar", 0, 0, 248, 10, 16, 72))
    .when(s.length > 0, (el) => el.child(sprite("posbar", p.drag?.kind === "seek" ? 278 : 248, 0, 29, 10, 16 + Math.round(seekFrac * 219), 72)))
    .child(track("seek", 16, 72, 248, 10, (f, done, cx) => { if (done) p.seek(f, cx); }))
    // Transport, eject (adds a folder), shuffle and repeat.
    .child(button("prev", "cbuttons", [0, 0], [0, 18], 23, 18, 16, 88, (cx) => p.transport("prev", cx), "Previous"))
    .child(button("play", "cbuttons", [23, 0], [23, 18], 23, 18, 39, 88, (cx) => p.transport("play", cx), "Play"))
    .child(button("pause", "cbuttons", [46, 0], [46, 18], 23, 18, 62, 88, (cx) => p.transport("pause", cx), "Pause"))
    .child(button("stop", "cbuttons", [69, 0], [69, 18], 23, 18, 85, 88, (cx) => p.transport("stop", cx), "Stop"))
    .child(button("next", "cbuttons", [92, 0], [92, 18], 22, 18, 108, 88, (cx) => p.transport("next", cx), "Next"))
    .child(button("eject", "cbuttons", [114, 0], [114, 16], 22, 16, 136, 89, (cx) => p.addFolder(cx), "Add a folder"))
    .child(button("shuffle", "shufrep", [28, sh ? 30 : 0], [28, sh ? 45 : 15], 47, 15, 164, 89, (cx) => p.toggleShuffle(cx), "Shuffle"))
    .child(button("repeat", "shufrep", [0, rp ? 30 : 0], [0, rp ? 45 : 15], 28, 15, 210, 89, (cx) => p.toggleRepeat(cx), "Repeat"));
}

// The skinned equalizer (eqmain.bmp): on, presets, preamp and ten band sliders. Bands apply on release.
export function skinnedEq(p, sk) {
  const S = p.set.scale, { cut, at, sprite } = painter(sk, S), eq = p.set.eq;
  const set = (i) => (f, done, cx) => {
    const v = Math.round(f * 24 - 12);
    p.set.eq = i < 0 ? { ...eq, preamp: v, preset: "" } : { ...eq, bands: eq.bands.map((b, j) => (j === i ? v : b)), preset: "" };
    if (done) p.audio({ eq: { ...p.set.eq, on: true } }, cx);
  };
  // A slider: its background frame follows the value (28 frames in two rows of 14), the thumb slides over 52 px.
  const slider = (i, value, x) => {
    const n = Math.round((value + 12) / 24 * 27);
    const live = p.drag?.kind === `eq${i}`;
    return [
      sprite("eqmain", 13 + (n % 14) * 15, 164 + Math.floor(n / 14) * 65, 14, 63, x, 38),
      sprite("eqmain", 0, live ? 176 : 164, 11, 11, x + 1, 38 + Math.round((12 - value) / 24 * 51)),
      div().id(`eqs-${i}`).absolute().left(x * S).top(38 * S).w(14 * S).h(63 * S)
        .on_mouse_down("left", (e, cx) => p.startDrag(`eq${i}`, e, set(i), cx)),
    ];
  };
  const names = [...Object.keys(EQ_PRESETS), ...(p.set.custom ? ["Custom"] : [])];
  const nextPreset = (cx) => p.eqPreset(names[(names.indexOf(eq.preset) + 1) % names.length], cx);
  const btn = (id, n, d, w, h, x, y, fn, label) => at(cut("eqmain", ...(p.pressed === id ? d : n), w, h), x, y).id(id)
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); p.pressed = id; cx.notify(); })
    .on_click((_e, cx) => fn(cx)).role("button").accessibility_label(label);
  return div().id("skin-eq").relative().w(275 * S).h(116 * S)
    .child(sprite("eqmain", 0, 0, 275, 116, 0, 0))
    .child(sprite("eqmain", 0, 134, 275, 14, 0, 0))
    .child(btn("eq-on", eq.on ? [69, 119] : [10, 119], eq.on ? [187, 119] : [128, 119], 26, 12, 14, 18,
      (cx) => p.audio({ eq: { ...eq, on: !eq.on } }, cx), eq.on ? "Equalizer off" : "Equalizer on"))
    .child(btn("eq-presets", [224, 164], [224, 176], 44, 12, 217, 18, nextPreset, `Next preset (${eq.preset || "custom"})`))
    .child(sprite("eqmain", 0, 294, 113, 19, 86, 17))
    .children(slider(-1, eq.preamp, 21))
    .children(eq.bands.flatMap((v, i) => slider(i, v, 78 + i * 18)));
}
