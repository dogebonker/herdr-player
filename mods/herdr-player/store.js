// The skin store: browse and search the Winamp Skin Museum (skins.webamp.org), see each skin's screenshot,
// and use one: it's downloaded into the hidden .skins/ folder (no mod reload, so the music keeps playing)
// and the player switches to it through shared state.

import { div, image } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, setShared, closeOverlay, props } from "herdr";

const API = "https://api.webamp.org/graphql";
const PAGE = 24;
const C = { bg: "#1b1b21", card: "#26262d", hi: "#4a4a57", text: "#c9c9d3", mute: "#7d7d8c", on: "#45f585" };
const stop = (_e, cx) => cx.stop_propagation();
// The museum's file name as a skin name: no extension, nothing a path or shell would mind.
export const skinName = (filename) => filename.replace(/\.(wsz|zip)$/i, "").replace(/[^\w .()+-]/g, "_").slice(0, 60);

export function storeInit(s, cx) {
  s.items = [];
  s.offset = 0;
  s.more = true;
  s.loading = false;
  s.shots = new Set();
  s.storeMsg = "";
  s.search = InputState.new({ placeholder: "Search the Skin Museum (e.g. zelda, metal, aqua)" });
  s.search.on("submit", (_e, cx) => { s.offset = 0; s.items = []; s.more = true; loadPage(s, cx); });
  cx.spawn(async (cx) => { await s.scanSkins(); cx.notify(); });
  loadPage(s, cx);
}

// Untrusted data: a hex md5 names files, only https URLs reach curl (it would read file:// too), no adult skins.
const https = (u) => typeof u === "string" && u.startsWith("https://");
const trusted = (x) => /^[0-9a-f]{32}$/.test(x?.md5 ?? "") && !x.nsfw && https(x.screenshot_url) && https(x.download_url);

async function gql(query, variables) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const j = await r.json();
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

// One page: the museum's own order, or search results. Adult skins are left out either way.
function loadPage(s, cx) {
  if (s.loading || !s.more) return;
  s.loading = true;
  s.storeMsg = "";
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const q = s.search.value().trim();
      const fields = "md5 filename nsfw screenshot_url download_url";
      const list = q
        ? (await gql(`query($q: String!, $n: Int, $o: Int) { search_classic_skins(query: $q, first: $n, offset: $o, nsfw: false) { ${fields} } }`,
          { q, n: PAGE, o: s.offset })).search_classic_skins
        : (await gql(`query($n: Int, $o: Int) { skins(first: $n, offset: $o, sort: MUSEUM) { nodes { ... on ClassicSkin { ${fields} } } } }`,
          { n: PAGE, o: s.offset })).skins.nodes;
      const fresh = (list ?? []).filter(trusted);
      s.items.push(...fresh);
      s.offset += PAGE;
      s.more = (list ?? []).length === PAGE;
      if (!s.items.length) s.storeMsg = q ? "No skins match." : "The museum didn't answer.";
      fetchShots(s, fresh, cx);
    } catch (e) {
      s.storeMsg = `Couldn't reach the Skin Museum: ${e.message ?? e}`;
    } finally {
      s.loading = false;
      cx.notify();
    }
  });
}

// Screenshots, six at a time: the main window only (the museum's include the equalizer and playlist), cached and
// pre-scaled 2x (nearest) so they stay sharp on a retina screen.
// ponytail: the preview cache is never trimmed; delete .store/ if it grows.
function fetchShots(s, items, cx) {
  const todo = [...items];
  const worker = async (cx) => {
    for (let x = todo.shift(); x; x = todo.shift()) {
      const out = `${s.dir}/.store/${x.md5}@2.png`;
      const r = await exec("sh", ["-c",
        '[ -s "$2" ] || { mkdir -p "$(dirname "$2")" && curl -sfL -m 20 -o "$2.src" "$1" && ffmpeg -v error -y -i "$2.src" -vf "crop=iw:min(ih\\,iw*116/275):0:0,scale=iw*2:ih*2:flags=neighbor" "$2" ; rm -f "$2.src"; }; [ -s "$2" ]',
        "shot", x.screenshot_url, out]).catch(() => ({ code: 1 }));
      if (r.code === 0) { s.shots.add(x.md5); cx.notify(); }
    }
  };
  for (let i = 0; i < 6; i++) cx.spawn(worker);
}

// A random skin from the whole museum: it's put first in the grid and used at once.
function randomSkin(s, cx) {
  if (s.rolling) return;
  s.rolling = true;
  s.storeMsg = "Picking a random skin…";
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      const fields = "md5 filename nsfw screenshot_url download_url";
      s.total ??= (await gql("{ skins(first: 1, sort: MUSEUM) { count } }")).skins.count;
      for (let tries = 0; tries < 6; tries++) {
        const o = Math.floor(Math.random() * s.total);
        const x = (await gql(`query($o: Int) { skins(first: 1, offset: $o, sort: MUSEUM) { nodes { ... on ClassicSkin { ${fields} } } } }`, { o })).skins.nodes?.[0];
        if (!trusted(x)) continue;
        s.items = [x, ...s.items.filter((y) => y.md5 !== x.md5)];
        fetchShots(s, [x], cx);
        useSkin(s, x, cx);
        return;
      }
      s.storeMsg = "No luck this time; try again.";
    } catch (e) {
      s.storeMsg = `Couldn't reach the Skin Museum: ${e.message ?? e}`;
    } finally {
      s.rolling = false;
      cx.notify();
    }
  });
}

// Downloads the skin (once) and tells the player to use it.
function useSkin(s, x, cx) {
  const name = skinName(x.filename);
  s.storeMsg = `Getting ${name}…`;
  cx.notify();
  cx.spawn(async (cx) => {
    const path = `${s.dir}/.skins/${name}.wsz`;
    const r = await exec("sh", ["-c", '[ -s "$2" ] || { mkdir -p "$(dirname "$2")" && curl -sfL -m 60 -o "$2.part" "$1" && mv "$2.part" "$2"; }; [ -s "$2" ]',
      "get", x.download_url, path]).catch(() => ({ code: 1 }));
    if (r.code !== 0) {
      s.storeMsg = `Couldn't download ${name}.`;
    } else {
      await s.scanSkins();
      setShared("herdr-player.skin", { name, at: Date.now() });
      s.storeMsg = `Using ${name}.`;
    }
    cx.notify();
  });
}

export function storeRender(s) {
  const installed = new Set(s.skins);
  const current = s.set.skin;
  const card = (x) => {
    const name = skinName(x.filename), has = installed.has(name), on = current === name;
    return v_flex().id(`skin-${x.md5}`).w(283).p(4).gap(4).rounded(4).bg(C.card).border(1).border_color(on ? C.on : C.hi)
      .child(div().w(275).h(116).bg("#000000")
        .when(s.shots.has(x.md5), (el) => el.child(image(`mods/herdr-player/.store/${x.md5}@2.png`).w(275).h(116))))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(C.text).child(name))
        .child(div().id(`use-${x.md5}`).h(18).px(8).flex_none().flex().items_center().rounded(2)
          .bg(on ? C.hi : C.bg).border(1).border_color(C.hi).text_size(10).text_color(on ? C.on : C.text)
          .hover((st) => st.text_color(C.on)).on_mouse_down("left", stop)
          .role("button").accessibility_label(`Use skin ${name}`)
          .on_click((_e, cx) => useSkin(s, x, cx))
          .child(on ? "In use" : has ? "Use" : "Get & use")));
  };
  const rows = [];
  for (let i = 0; i < s.items.length; i += 2) rows.push(h_flex().gap(8).children(s.items.slice(i, i + 2).map(card)));
  return v_flex().id("store").size_full().p(10).gap(8).bg(C.bg).text_color(C.text)
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(12).font_bold().text_color(C.mute).child("SKIN MUSEUM"))
      .child(div().flex_1().text_size(10).text_color(C.mute).child("skins.webamp.org"))
      .child(div().id("store-close").size(16).flex().items_center().justify_center().rounded(2).bg(C.card).border(1).border_color(C.hi)
        .text_size(11).text_color(C.mute).hover((st) => st.text_color(C.text)).on_mouse_down("left", stop)
        .role("button").accessibility_label("Close the skin store").on_click(() => closeOverlay(props().overlay)).child("×")))
    .child(h_flex().h(26).px(6).gap(6).items_center().rounded(3).bg("#070b08").border(1).border_color(C.hi).on_mouse_down("left", stop)
      .child(Input.new(s.search).flex_1().h_full().text_size(12).text_color(C.text))
      .child(div().id("store-random").h(18).px(8).flex_none().flex().items_center().rounded(2).bg(C.card).border(1).border_color(C.hi)
        .text_size(10).text_color(C.text).hover((st) => st.text_color(C.on)).on_mouse_down("left", stop)
        .role("button").accessibility_label("Use a random skin").on_click((_e, cx) => randomSkin(s, cx))
        .child(s.rolling ? "…" : "Random")))
    .when(Boolean(s.storeMsg), (el) => el.child(div().text_size(11).text_color(C.mute).child(s.storeMsg)))
    .child(v_flex().id("store-grid").flex_1().min_h(0).gap(8).overflow_y_scroll().on_mouse_down("left", stop)
      .children(rows)
      .when(s.more && s.items.length > 0, (el) => el.child(div().id("store-more").h(24).flex().items_center().justify_center().rounded(3)
        .bg(C.card).border(1).border_color(C.hi).text_size(11).hover((st) => st.text_color(C.on))
        .on_click((_e, cx) => loadPage(s, cx)).child(s.loading ? "Loading…" : "More skins")))
      .when(s.loading && !s.items.length, (el) => el.child(div().text_size(11).text_color(C.mute).child("Loading the museum…"))));
}
