// The playlist and equalizer panels, shared by both looks. `pal` colours them: the skin's playlist colours
// (pledit.txt) or the built-in look's.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, Input } from "gpui-base";

export const EQ_LABELS = ["60", "170", "310", "600", "1K", "3K", "6K", "12K", "14K", "16K"];
// Gains in dB, -12..12. Our own curves, in the spirit of the old presets.
export const EQ_PRESETS = {
  Flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  Rock: [5, 3, -2, -4, -1, 2, 5, 6, 6, 6],
  Pop: [-1, 3, 5, 5, 2, -1, -2, -2, -1, -1],
  Jazz: [4, 3, 1, 2, -1, -1, 0, 1, 3, 4],
  Classical: [0, 0, 0, 0, 0, 0, -4, -4, -4, -6],
  Bass: [7, 6, 5, 2, 0, -2, -3, -3, -3, -3],
  Vocal: [-2, -3, -3, 1, 4, 4, 3, 1, 0, -2],
};

export const VIS_MODES = ["bars", "meter", "off"];
export const mmss = (s) => !(s >= 0) ? "--:--" : `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const stop = (_e, cx) => cx.stop_propagation();

// A flat little button in the panel's colours.
export const chip = (pal, id, label, fn, on) => div().id(id).h(18).px(5).flex_none().flex().items_center().justify_center()
  .rounded(2).bg(on ? pal.sel : pal.face).border(1).border_color(pal.edge).text_size(10).text_color(on ? pal.current : pal.text)
  .hover((s) => s.text_color(pal.current)).on_mouse_down("left", stop).on_click((_e, cx) => fn(cx)).child(label);

export function playlistPanel(p, pal, width) {
  // Press a queue row and let go on another to move it there; a click plays it.
  const row = (e, i, queued) => h_flex().id(`${queued ? "q" : "r"}-${i}`).h(20).px(4).gap(6).flex_none().items_center()
    .text_size(11).text_color(e.current ? pal.current : pal.text)
    .when(e.current || (queued && p.plDrag === i), (el) => el.bg(pal.sel)).hover((s) => s.bg(pal.sel))
    .on_mouse_down("left", (_ev, cx) => { cx.stop_propagation(); if (queued) p.plDrag = i; })
    .on_mouse_up("left", (_ev, cx) => {
      if (queued && p.plDrag != null && p.plDrag !== i) { p.queueAct("move", p.plDrag, i, cx); p.plDrag = null; p.movedAt = Date.now(); }
    })
    .on_click((ev, cx) => {
      if (Date.now() - (p.movedAt ?? 0) < 200) return;
      if (queued) p.queueAct("play", i, 0, cx);
      else p.act(cx, () => p.play(e, ev.modifiers?.shift ? "append-play" : "replace"));
    })
    .child(div().w(20).flex_none().text_color(pal.dim).opacity(0.7).child(`${i + 1}.`))
    .child(div().flex_1().min_w(0).truncate().child(e.title))
    .when(!queued && Boolean(e.by), (el) => el.child(div().max_w(90).truncate().opacity(0.7).child(e.by)))
    .when(!queued && e.length > 0, (el) => el.child(div().w(36).flex_none().opacity(0.7).child(mmss(e.length))))
    .child(div().id(`${queued ? "rm" : "add"}-${i}`).px(3).flex_none().opacity(0.7).hover((s) => s.opacity(1))
      .on_mouse_down("left", stop)
      .on_click((_ev, cx) => {
        cx.stop_propagation();
        if (queued) p.queueAct("remove", i, 0, cx);
        else p.act(cx, () => p.play(e, "append-play"));
      })
      .child(queued ? "×" : "+"));
  const list = (label, items, queued) => v_flex().gap(1)
    .child(div().text_size(9).text_color(pal.dim).opacity(0.7).child(label))
    .child(v_flex().id(`${label}-list`).max_h(140).overflow_y_scroll().children(items.map((e, i) => row(e, i, queued))));

  const sp = p.set.tab === "sp";
  const box = (state, go, busy) => h_flex().h(22).px(4).gap(4).items_center().bg(pal.bg).border(1).border_color(pal.edge).on_mouse_down("left", stop)
    .child(Input.new(state).flex_1().h_full().text_size(11).text_color(pal.text))
    .child(chip(pal, sp ? "sp-go" : "go", busy ? "…" : "Go", go));
  return v_flex().id("pl").w(width).p(4).gap(4).bg(pal.face).border(1).border_color(pal.edge).font_family(pal.font)
    .child(h_flex().gap(4).items_center()
      .child(chip(pal, "tab-yt", "YouTube", (cx) => p.save({ tab: "yt" }, cx), !sp))
      .child(chip(pal, "tab-sp", "Spotify", (cx) => p.save({ tab: "sp" }, cx), sp))
      .child(div().flex_1())
      .child(chip(pal, "pl-add", "+Dir", (cx) => p.addFolder(cx)))
      .child(chip(pal, "pl-save", "Save", (cx) => p.saveList(cx)))
      .child(chip(pal, "pl-clear", "Clear", (cx) => p.queueAct("clear", 0, 0, cx))))
    .child(sp ? box(p.spQuery, (cx) => p.loadSpotify(cx), p.spBusy) : box(p.query, (cx) => p.submit(cx), p.busy))
    .when(Boolean(p.message), (el) => el.child(div().text_size(10).text_color(pal.dim).child(p.message)))
    .when(!sp && p.results.length > 0, (el) => el.child(list("RESULTS · click plays, + queues", p.results, false)))
    .when(sp, (el) => el.child(spotifyAccount(p, pal)).child(
      p.spView === "search" && p.spFound ? spotifyFound(p, pal)
        : p.spView === "playlists" ? spotifyLists(p, pal, p.spLists, "YOUR PLAYLISTS")
        : p.sp ? spotifyCard(p, pal)
        : div().text_size(10).text_color(pal.dim).opacity(0.8)
          .child(p.spot.premium === true ? "Search Spotify above, or open your playlists or liked songs."
            : "Paste a Spotify song, album, playlist or artist link. No account needed: each song plays from YouTube.")))
    .child(p.queue.length ? list("PLAYLIST · drag to reorder", p.queue, true)
      : div().text_size(10).text_color(pal.dim).opacity(0.7).child("Empty. Search, paste a YouTube or Spotify link, or drop files here."));
}

// A loaded Spotify link: cover, name, who it's by, Play all, and its songs (a click plays one, + queues it).
// The song playing now is lit.
function spotifyCard(p, pal) {
  const sp = p.sp, playing = p.state.origin === "sp" ? p.state.title : null, list = undefined;
  const song = (t, i) => {
    const on = playing === (t.by ? `${t.by} - ${t.title}` : t.title);
    return h_flex().id(`sp-${i}`).h(20).px(4).gap(6).flex_none().items_center().text_size(11)
      .text_color(on ? pal.current : pal.text).when(on, (el) => el.bg(pal.sel)).hover((s) => s.bg(pal.sel))
      .on_mouse_down("left", stop).on_click((_ev, cx) => p.playSpotify(i, "replace", cx, list))
      .child(div().w(20).flex_none().text_color(pal.dim).opacity(0.7).child(`${i + 1}.`))
      .child(div().flex_1().min_w(0).truncate().child(t.title))
      .when(sp.kind !== "album" && Boolean(t.by), (el) => el.child(div().max_w(90).truncate().opacity(0.7).child(t.by)))
      .when(t.ms > 0, (el) => el.child(div().w(36).flex_none().opacity(0.7).child(mmss(t.ms / 1000))))
      // Queueing goes through YouTube; Spotify's own playback doesn't take a queue from here.
      .when(!p.spot.premium, (el) => el.child(div().id(`sp-add-${i}`).px(3).flex_none().opacity(0.7).hover((s) => s.opacity(1)).on_mouse_down("left", stop)
        .on_click((_ev, cx) => { cx.stop_propagation(); p.playSpotify(i, "append-play", cx, list); }).child("+")));
  };
  return v_flex().gap(4)
    .child(h_flex().gap(8).items_center()
      .child(div().size(56).flex_none().rounded(3).overflow_hidden().bg(pal.bg)
        .when(Boolean(sp.coverPath), (el) => el.child(image(sp.coverPath).size(56))))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().text_size(9).text_color(pal.dim).opacity(0.7).child(`SPOTIFY ${sp.kind.toUpperCase()}`))
        .child(div().truncate().text_size(13).font_bold().text_color(pal.current).child(sp.name))
        .child(div().truncate().text_size(10).text_color(pal.dim).child(`${sp.by ? `${sp.by} · ` : ""}${sp.songs.length} song${sp.songs.length === 1 ? "" : "s"}`)))
      .child(chip(pal, "sp-all", "Play all", (cx) => p.playSpotify(null, "replace", cx), true)))
    .child(v_flex().id("sp-list").max_h(140).overflow_y_scroll().children(sp.songs.map(song)));
}

// The account line: connect, or how it's connected, with your playlists and liked songs once logged in.
function spotifyAccount(p, pal) {
  const s = p.spot;
  const state = !s.installed || !s.loggedIn ? "Spotify Premium? Connect it."
    : s.premium === null ? "Spotify · connecting…"
    : s.premium ? "Spotify · Premium" : "Spotify didn't connect (Premium?)";
  const ready = s.premium === true;
  return h_flex().gap(4).items_center()
    .child(div().flex_1().min_w(0).truncate().text_size(9).text_color(ready ? pal.current : pal.dim).opacity(ready ? 1 : 0.8).child(state))
    .when(!s.loggedIn, (el) => el.child(chip(pal, "sp-connect", s.installed ? "Connect" : "Install", (cx) => p.connectSpotify(cx))))
    .when(s.loggedIn && s.premium === false, (el) => el.child(chip(pal, "sp-retry", "Retry", (cx) => p.connectSpotify(cx))))
    .when(ready, (el) => el
      .child(chip(pal, "sp-playlists", "Playlists", (cx) => p.showSpotify("playlists", cx), p.spView === "playlists"))
      .child(chip(pal, "sp-liked", "Liked", (cx) => p.showSpotify("liked", cx), p.sp?.kind === "liked" && p.spView === "card")));
}

// Albums, playlists or artists to open as cards.
function spotifyLists(p, pal, lists, label) {
  return v_flex().gap(1)
    .child(div().text_size(9).text_color(pal.dim).opacity(0.7).child(label))
    .child(v_flex().id(`${label}-list`).max_h(160).overflow_y_scroll().children(lists.map((l, i) =>
      h_flex().id(`spl-${i}`).h(20).px(4).gap(6).flex_none().items_center().text_size(11).text_color(pal.text).hover((s) => s.bg(pal.sel))
        .on_mouse_down("left", stop).on_click((_ev, cx) => p.openSpotify(l.kind, l.id, cx))
        .child(div().w(46).flex_none().text_size(8).text_color(pal.dim).opacity(0.7).child(l.kind.toUpperCase()))
        .child(div().flex_1().min_w(0).truncate().child(l.name))
        .when(Boolean(l.by), (el) => el.child(div().max_w(100).truncate().opacity(0.7).child(l.by))))));
}

// Spotify search results: songs to play, then albums, playlists and artists to open.
function spotifyFound(p, pal) {
  const f = p.spFound, playing = p.state.origin === "sp" ? p.state.title : null;
  return v_flex().gap(4)
    .when(f.songs.length > 0, (el) => el.child(v_flex().gap(1)
      .child(div().text_size(9).text_color(pal.dim).opacity(0.7).child("SONGS · click plays"))
      .children(f.songs.map((t, i) => {
        const on = playing === (t.by ? `${t.by} - ${t.title}` : t.title);
        return h_flex().id(`spf-${i}`).h(20).px(4).gap(6).flex_none().items_center().text_size(11)
          .text_color(on ? pal.current : pal.text).when(on, (el) => el.bg(pal.sel)).hover((s) => s.bg(pal.sel))
          .on_mouse_down("left", stop).on_click((_ev, cx) => p.playSpotify(i, "replace", cx, f.songs))
          .child(div().flex_1().min_w(0).truncate().child(t.title))
          .child(div().max_w(100).truncate().opacity(0.7).child(t.by))
          .when(t.ms > 0, (el) => el.child(div().w(36).flex_none().opacity(0.7).child(mmss(t.ms / 1000))));
      }))))
    .when(f.lists.length > 0, (el) => el.child(spotifyLists(p, pal, f.lists, "ALBUMS · PLAYLISTS · ARTISTS")));
}

// The built-in equalizer: on/off, presets, preamp and ten bands. Bands apply on release.
export function eqPanel(p, pal, width) {
  const eq = p.set.eq;
  const set = (i) => (f, done, cx) => {
    const v = Math.round(f * 24 - 12);
    const next = i < 0 ? { ...eq, preamp: v } : { ...eq, bands: eq.bands.map((b, j) => (j === i ? v : b)) };
    p.set.eq = { ...next, preset: "" };
    if (done) p.audio({ eq: { ...p.set.eq, on: true } }, cx);
  };
  const slider = (i, value, label) => v_flex().items_center().gap(2).flex_1()
    .child(div().id(`eqs-${i}`).w(10).h(70).relative().rounded(2).bg(pal.bg).border(1).border_color(pal.edge)
      .on_mouse_down("left", (e, cx) => p.startDrag(`eq${i}`, e, set(i), cx))
      .child(div().absolute().left(0).w_full().h(1).top(34).bg(pal.edge))
      .child(div().absolute().left(-2).w(12).h(6).rounded(1).bg(eq.on ? pal.current : pal.dim).top(Math.round((12 - value) / 24 * 62))))
    .child(div().text_size(8).text_color(pal.dim).child(label));
  const presets = [...Object.keys(EQ_PRESETS), ...(p.set.custom ? ["Custom"] : [])];
  return v_flex().id("eq").w(width).p(4).gap(4).bg(pal.face).border(1).border_color(pal.edge).font_family(pal.font)
    .child(h_flex().gap(4).items_center()
      .child(chip(pal, "eq-on", eq.on ? "EQ ON" : "EQ OFF", (cx) => p.audio({ eq: { ...eq, on: !eq.on } }, cx), eq.on))
      .child(div().flex_1())
      .child(chip(pal, "eq-save", "Save", (cx) => p.eqSaveCustom(cx))))
    .child(h_flex().gap(3).flex_wrap().children(presets.map((n) => chip(pal, `eqp-${n}`, n, (cx) => p.eqPreset(n, cx), eq.preset === n))))
    .child(h_flex().gap(2).items_end()
      .child(slider(-1, eq.preamp, "PRE"))
      .child(div().w(6))
      .children(eq.bands.map((v, i) => slider(i, v, EQ_LABELS[i]))));
}
