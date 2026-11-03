// The built-in look: a dark bevelled case with a green LCD. Everything the skinned
// window offers is here too: shuffle, repeat, EQ and playlist toggles, balance, elapsed/remaining, the
// visualizer modes, shade, and the skin switch.

import { div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { mmss, VIS_MODES } from "./panels.js";

const C = {
  case: "#26262d", hi: "#4a4a57", lo: "#111115", face: "#33333c", faceHi: "#40404b",
  lcd: "#070b08", on: "#45f585", dim: "#1d5c34", text: "#c9c9d3", mute: "#7d7d8c",
};
const LCD = "JetBrains Mono";
const BARS = 18;
const stop = (_e, cx) => cx.stop_propagation();

export function classicMain(p) {
  const s = p.state, set = p.set, glow = C.on;
  const key = (id, label, fn, on) => div().id(id).h(22).px(7).flex_none().flex().items_center().justify_center()
    .rounded(3).bg(on ? C.faceHi : C.face).border(1).border_color(on ? C.lo : C.hi).text_size(11).text_color(on ? glow : C.text)
    .hover((st) => st.bg(C.faceHi)).on_mouse_down("left", stop).on_click((_e, cx) => fn(cx)).child(label);
  // A track bar: press or drag anywhere on it.
  const bar = (id, frac, color, apply, center) => div().id(id).h(8).flex_1().rounded(2).bg(C.lo).border(1).border_color(C.hi).relative()
    .on_mouse_down("left", (e, cx) => p.startDrag(id, e, apply, cx))
    .when(center, (el) => el.child(div().absolute().top(0).h_full().w(1).left("50%").bg(C.hi)))
    .child(div().absolute().left(0).top(0).h_full().rounded(2).bg(color).w(`${Math.round(Math.max(0, Math.min(1, frac)) * 100)}%`));
  const dragging = (kind) => (p.drag?.kind === kind ? p.drag.frac : null);
  const seekFrac = dragging("seek") ?? (s.length > 0 ? s.time / s.length : 0);
  const shown = set.remaining && s.length > 0 && s.time >= 0 ? s.length - s.time : s.time;
  const clock = `${set.remaining && s.time >= 0 ? "-" : " "}${mmss(shown)}`;
  const title = s.title || "herdr-player";
  const glyph = s.playing ? "▶" : s.paused ? "❚❚" : "■";

  const titlebar = h_flex().h(16).gap(6).items_center()
    .child(div().text_size(10).font_bold().text_color(C.mute).font_family(LCD).child("HERDR-PLAYER"))
    .child(div().flex_1().h(4).rounded(1).bg(C.lo))
    .child(div().id("skin").px(4).h(14).flex().items_center().rounded(2).bg(C.face).border(1).border_color(C.hi)
      .text_size(9).text_color(C.mute).hover((st) => st.text_color(C.text)).on_mouse_down("left", stop)
      .role("button").accessibility_label("Next skin").on_click((_e, cx) => p.nextSkin(cx))
      .child(`SKIN: ${p.skin?.name ?? "built-in"}`))
    .child(div().id("store").px(4).h(14).flex().items_center().rounded(2).bg(C.face).border(1).border_color(C.hi)
      .text_size(9).text_color(C.mute).hover((st) => st.text_color(C.text)).on_mouse_down("left", stop)
      .role("button").accessibility_label("Skin store").on_click(() => p.openStore()).child("STORE"))
    .child(small("shade", set.shade ? "▾" : "▴", "Shade", (cx) => p.save({ shade: !set.shade }, cx)))
    .child(small("close", "×", "Close player, stopping the music", () => p.closeWindow()));

  // Shaded: one strip with the essentials.
  if (set.shade) return v_flex().id("classic").w(380).p(6).gap(6).rounded(8).bg(C.case).border(1).border_color(C.hi).text_color(C.text)
    .child(titlebar)
    .child(h_flex().h(22).px(6).gap(8).items_center().rounded(3).bg(C.lcd).border(1).border_color(C.lo).font_family(LCD)
      .child(div().text_size(11).text_color(glow).child(glyph))
      .child(div().text_size(12).font_bold().text_color(glow).child(clock))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(glow).child(title))
      .child(key("s-prev", "⏮", (cx) => p.transport("prev", cx)))
      .child(key("s-play", s.playing ? "⏸" : "▶", (cx) => p.transport("toggle", cx), s.playing))
      .child(key("s-next", "⏭", (cx) => p.transport("next", cx))));

  // The marquee scrolls a title too long for the LCD back and forth, natively.
  const width = 236, chars = Math.floor(width / 7.2);
  const marquee = div().id("marquee").w(width).h(16).overflow_hidden().relative()
    .child(div().id(`marquee-${title}`).absolute().top(0).text_size(12).text_color(glow).whitespace_nowrap()
      .when(title.length > chars && s.playing, (el) => el.loop("left", { from: 0, to: -(title.length - chars) * 7.2, period: title.length * 260, easing: "linear" }))
      .child(title));
  // Bars: motion only (mpv hands out no spectrum). Meter: mpv's live levels, left and right.
  const vis = set.vis === "bars"
    ? h_flex().h(22).gap(1).items_end().children(Array.from({ length: BARS }, (_, i) =>
      div().id(`bar-${i}`).w(3).h(2).bg(glow).opacity(0.85)
        .when(s.playing, (el) => el.loop("height", { from: 2, to: 6 + ((i * 7) % 15), period: 380 + ((i * 97) % 520) }))))
    : set.vis === "meter"
      ? v_flex().h(22).w(73).gap(4).justify_center().children(p.levels.map((lv, i) =>
        div().id(`lv-${i}`).h(5).bg(glow).opacity(0.85).w(Math.round(2 + lv * 71)).transition("width", 120)))
      : div().h(22).w(73).text_size(9).text_color(C.dim).child("VIS OFF");
  const info = [s.kbps ? `${s.kbps}kbps` : "", s.khz ? `${s.khz}kHz` : ""].filter(Boolean).join(" ");

  const lcd = h_flex().id("lcd").p(8).gap(10).rounded(4).bg(C.lcd).border(1).border_color(C.lo).font_family(LCD)
    .child(v_flex().gap(4).flex_none()
      .child(h_flex().id("clock").gap(6).items_center().on_mouse_down("left", stop)
        .role("button").accessibility_label(set.remaining ? "Show elapsed time" : "Show remaining time")
        .on_click((_e, cx) => p.save({ remaining: !set.remaining }, cx))
        .child(div().text_size(12).text_color(glow).child(glyph))
        .child(div().text_size(24).font_bold().text_color(glow).child(clock)))
      .child(div().id("vis").on_mouse_down("left", stop).role("button").accessibility_label("Change visualizer")
        .on_click((_e, cx) => p.audio({ vis: VIS_MODES[(VIS_MODES.indexOf(set.vis) + 1) % VIS_MODES.length] }, cx))
        .child(vis)))
    .child(v_flex().flex_1().min_w(0).gap(6)
      .child(marquee)
      .child(h_flex().gap(8).text_size(10).text_color(C.dim)
        .child(div().text_color(info ? glow : C.dim).child(info || "--- kbps"))
        .child(div().flex_1())
        .child(div().text_color(s.channels === 1 ? glow : C.dim).child("MONO"))
        .child(div().text_color(s.channels >= 2 ? glow : C.dim).child("STEREO")))
      .child(h_flex().gap(8).text_size(10).text_color(C.dim)
        .child(div().text_color(s.origin === "yt" ? glow : C.dim).child("YT"))
        .child(div().text_color(s.origin === "sp" ? glow : C.dim).child("SPOTIFY"))
        .child(div().text_color(s.origin === "file" ? glow : C.dim).child("FILE"))
        .child(div().flex_1())
        .child(div().text_color(set.shuffle ? glow : C.dim).child("SHUF"))
        .child(div().text_color(set.repeat ? glow : C.dim).child("REP"))
        .child(div().child(mmss(s.length)))));

  const vol = dragging("vol") ?? s.volume / 100, bal = dragging("bal") ?? (set.balance + 1) / 2;
  return v_flex().id("classic").w(380).p(8).gap(8).rounded(8).bg(C.case).border(1).border_color(C.hi).text_color(C.text)
    .child(titlebar)
    .child(lcd)
    .child(bar("seek", seekFrac, glow, (f, done, cx) => { if (done) p.seek(f, cx); }))
    .child(h_flex().gap(4).items_center()
      .child(key("prev", "⏮", (cx) => p.transport("prev", cx)))
      .child(key("play", "▶", (cx) => p.transport("play", cx), s.playing))
      .child(key("pause", "⏸", (cx) => p.transport("pause", cx), s.paused))
      .child(key("stop", "⏹", (cx) => p.transport("stop", cx)))
      .child(key("next", "⏭", (cx) => p.transport("next", cx)))
      .child(div().flex_1())
      .child(key("shuffle", "SHUF", (cx) => p.toggleShuffle(cx), set.shuffle))
      .child(key("repeat", "REP", (cx) => p.toggleRepeat(cx), set.repeat))
      .child(key("eq", "EQ", (cx) => p.save({ eqOpen: !set.eqOpen }, cx), set.eqOpen))
      .child(key("pl", "PL", (cx) => p.save({ plOpen: !set.plOpen }, cx), set.plOpen)))
    .child(h_flex().gap(6).items_center().text_size(9).text_color(C.mute).font_family(LCD)
      .child(div().child("VOL"))
      .child(bar("vol", vol, C.dim, (f, done, cx) => { p.state.volume = Math.round(f * 100); if (done) p.volume(f * 100, cx); }))
      .child(div().child("BAL"))
      .child(bar("bal", bal, C.dim, (f, done, cx) => {
        const b = Math.abs(f * 2 - 1) < 0.08 ? 0 : f * 2 - 1;
        p.set.balance = b;
        if (done) p.audio({ balance: b }, cx);
      }, true)));
}

function small(id, label, name, fn) {
  return div().id(id).size(14).flex().items_center().justify_center().rounded(2).bg(C.face).border(1).border_color(C.hi)
    .text_size(10).text_color(C.mute).hover((st) => st.text_color(C.text)).on_mouse_down("left", stop)
    .role("button").accessibility_label(name).on_click((_e, cx) => fn(cx)).child(label);
}
