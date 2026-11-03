// herdr-player: a small retro music window. Everything plays through mpv: YouTube, Spotify links (each song found
// on YouTube, no Spotify app or account), and local files. The window is the remote: mpv runs in herdr-core as
// `herdr-player` and stops when the window closes.
// YouTube refuses mpv's own stream request (403), so yt-dlp downloads each track to a cache first and mpv plays
// the file: seek, pause and the queue all work. Local files and folders play the same way.
//
// Two looks: the built-in one (classic.js), or a classic .wsz skin from skins/ (skin.js, converted by skin.py).
// Both share the playlist and equalizer panels (panels.js).

import { View, div } from "gpui-kit";
import { v_flex, InputState } from "gpui-base";
import { exec, hc, home, props, closeOverlay, notify, pickFolder, writeTextFile, nextCommand, openOverlay, shared } from "herdr";
import { storeInit, storeRender } from "./store.js";
import { classicMain } from "./classic.js";
import { loadSkin, skinnedMain, skinnedEq } from "./skin.js";
import { playlistPanel, eqPanel, EQ_PRESETS } from "./panels.js";

const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const AUDIO = ["mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "aiff", "webm", "wma"];

const ytUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const ytId = (url) => /(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/.exec(url)?.[1] ?? null;
const isYtList = (q) => /^https?:\/\//.test(q) && /[?&]list=|\/playlist/.test(q);
const isYtVideo = (q) => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(q);
const basename = (p) => p.split("/").pop().replace(/\.[^.]+$/, "");
// A Spotify link (open.spotify.com/…/track/ID, or spotify:track:ID): its kind and id, or null.
const spotifyLink = (q) => {
  const m = /^spotify:(track|album|playlist|artist):([A-Za-z0-9]+)$/.exec(q)
    ?? /^https:\/\/open\.spotify\.com\/(?:intl-[\w-]+\/)?(?:embed\/)?(track|album|playlist|artist)\/([A-Za-z0-9]+)/.exec(q);
  return m ? { kind: m[1], id: m[2] } : null;
};

// Settings kept per window copy; anything missing takes its default.
const DEFAULTS = {
  skin: null, scale: 1, vis: "bars", remaining: false, shuffle: false, repeat: false,
  balance: 0, eq: { on: false, preamp: 0, bands: Array(10).fill(0), preset: "Flat" }, custom: null,
  eqOpen: false, plOpen: true, shade: false, tab: "yt", spLink: "",
};

export default class Player extends View {
  init(_props, cx) {
    // The same mod, opened with { store: true }, is the skin store window (store.js).
    this.isStore = Boolean(props()?.store);
    const saved = JSON.parse(localStorage.getItem("settings") ?? "{}");
    this.set = { ...DEFAULTS, ...saved, eq: { ...DEFAULTS.eq, ...saved.eq } };
    this.state = { playing: false, paused: false, title: "", time: -1, length: -1, volume: 70, kbps: 0, khz: 0, channels: 0 };
    this.levels = [0, 0];
    this.queue = [];
    this.results = [];
    this.titles = JSON.parse(localStorage.getItem("titles") ?? "{}");
    // Where each queued file came from (yt, sp), for the display; anything else is a local file.
    this.origins = JSON.parse(localStorage.getItem("origins") ?? "{}");
    this.message = "";
    this.busy = false;
    this.pressed = null;
    this.drag = null;
    this.plDrag = null;
    this.skin = null;
    this.skins = [];
    this.query = InputState.new({ placeholder: "Search YouTube, or paste a YouTube or Spotify link" });
    this.query.on("submit", (_e, cx) => this.submit(cx));
    // The Spotify tab's link box; the last link loads again when the player opens.
    this.spQuery = InputState.new({ placeholder: "Paste a Spotify song, album, playlist or artist link" });
    this.spQuery.on("submit", (_e, cx) => this.loadSpotify(cx));
    this.sp = null;
    this.spBusy = false;
    this.dir = `${home()}/.config/herdr-app/mods/herdr-player`;
    this.ctl = `${this.dir}/mpvctl.py`;
    this.cache = `${home()}/Library/Caches/herdr-player`;
    // mpv's socket accepts `run`, so it lives in a folder only you can open, not in the shared /tmp.
    // ponytail: one socket per user, so one player; a per-window socket if two are ever wanted.
    this.sock = `${this.cache}/mpv.sock`;
    if (this.isStore) return storeInit(this, cx);
    // A skin request from the store (shared state); one already there when the window opens is old news.
    this.applied = shared("herdr-player.skin")?.at ?? 0;
    // ponytail: cache trimmed by age (14 days) only, a size cap if long mixes fill the disk.
    exec("find", [this.cache, "-type", "f", "-mtime", "+14", "-delete"]).catch(() => null);
    cx.timer.every(1000, (cx) => this.poll(cx));
    // The level meter reads mpv's levels a few times a second, only while it shows and plays.
    cx.timer.every(150, (cx) => { if (this.set.vis === "meter" && this.state.playing && !this.set.shade) this.pollLevels(cx); });
    // Keys from keys.json (`herdr-player.toggle`, `herdr-player.next`); they reach the player while its window is open.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle" || c === "next") this.transport(c, cx);
      }
    });
    if (this.set.spLink) {
      this.spQuery.set_value(this.set.spLink);
      this.loadSpotify(cx);
    }
    cx.spawn(async (cx) => {
      await this.scanSkins();
      if (this.set.skin) await this.useSkin(this.set.skin, cx);
      cx.notify();
    });
    this.poll(cx);
  }

  save(patch, cx) {
    Object.assign(this.set, patch);
    localStorage.setItem("settings", JSON.stringify(this.set));
    cx?.notify();
  }

  // ---- skins ----

  // Skins: skins/ (yours, by hand) and .skins/ (store downloads and drops; hidden, so adding one doesn't reload
  // the mod and stop the music).
  async scanSkins() {
    const r = await exec("sh", ["-c", 'for f in "$1"/*.wsz "$2"/*.wsz; do [ -e "$f" ] && echo "$f"; done', "ls", `${this.dir}/skins`, `${this.dir}/.skins`]).catch(() => null);
    this.skinPaths = {};
    for (const f of (r?.stdout ?? "").split("\n").filter(Boolean)) this.skinPaths[f.split("/").pop().replace(/\.wsz$/i, "")] = f;
    this.skins = Object.keys(this.skinPaths).sort();
  }

  openStore() {
    openOverlay({ mod: "herdr-player", props: { store: true }, kind: "window", key: "herdr-player-store", width: 600, height: 640 });
  }

  // Converts the skin on first use (into a hidden folder, so it doesn't reload the mod), then loads it.
  async useSkin(name, cx) {
    if (!name) { this.skin = null; this.save({ skin: null }, cx); return; }
    const out = `${this.dir}/.skins/${name}`;
    let manifest = await loadSkin(out);
    if (!manifest) {
      this.message = `Converting skin ${name}…`;
      cx.notify();
      if (!this.skinPaths?.[name]) await this.scanSkins();
      const r = await exec("python3", [`${this.dir}/skin.py`, this.skinPaths[name] ?? `${this.dir}/skins/${name}.wsz`, out]).catch((e) => ({ code: 1, stderr: String(e) }));
      if (r.code !== 0) {
        this.message = `Skin ${name} failed: ${r.stderr.trim().split("\n").pop()}`;
        this.skin = null;
        this.save({ skin: name }, cx);
        return;
      }
      manifest = await loadSkin(out);
    }
    this.skin = manifest ? { ...manifest, name, path: `mods/herdr-player/.skins/${name}` } : null;
    this.message = "";
    this.save({ skin: this.skin ? name : null }, cx);
  }

  // Built-in, then each skin in skins/, round and round.
  nextSkin(cx) {
    cx.spawn(async (cx) => {
      await this.scanSkins();
      const list = [null, ...this.skins], i = list.indexOf(this.set.skin);
      await this.useSkin(list[(i + 1) % list.length], cx);
      cx.notify();
    });
  }

  // ---- mpv ----

  async mpv(cmds) {
    const r = await exec("python3", [this.ctl, this.sock, JSON.stringify(cmds)]).catch(() => null);
    if (!r || r.code !== 0) return null;
    try { return JSON.parse(r.stdout); } catch { return null; }
  }

  ensureMpv() {
    this.starting ??= this.startMpv().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startMpv() {
    if (await this.mpv([["get_property", "idle-active"]])) return true;
    await exec("sh", ["-c", 'mkdir -p "$1" && chmod 700 "$1" && rm -f "$2"', "prep", this.cache, this.sock]).catch(() => null);
    await hc(["run", "--bg", "--no-parent", "--no-notify", "--rm", "--name", "herdr-player", "--label", "herdr-player=1", "--",
      "mpv", "--idle=yes", "--no-video", "--no-terminal", "--force-window=no", `--input-ipc-server=${this.sock}`,
      `--volume=${this.state.volume}`]).catch(() => null);
    for (let i = 0; i < 20; i++) {
      if (await this.mpv([["get_property", "idle-active"]])) {
        await this.applyAudio();
        await this.mpv([["set_property", "loop-playlist", this.set.repeat ? "inf" : "no"], ["set_property", "shuffle", this.set.shuffle]]);
        return true;
      }
      await exec("sleep", ["0.2"]);
    }
    notify({ title: "herdr-player", body: "mpv didn't start. Is it installed (brew install mpv yt-dlp)?", level: "error" });
    return false;
  }

  // The equalizer, balance and level meter as one labelled filter graph (`@hp`), rebuilt when any changes.
  afGraph() {
    const parts = [], { eq, balance, vis } = this.set;
    if (eq.on) {
      if (eq.preamp) parts.push(`volume=${eq.preamp}dB`);
      eq.bands.forEach((g, i) => { if (g) parts.push(`equalizer=f=${EQ_FREQS[i]}:t=o:w=1:g=${g}`); });
    }
    if (balance) parts.push(`stereotools=balance_out=${balance.toFixed(2)}`);
    if (vis === "meter") parts.push("astats=metadata=1:reset=1:measure_overall=none:measure_perchannel=RMS_level");
    return parts.length ? `@hp:lavfi=[${parts.join(",")}]` : "";
  }
  applyAudio() { return this.mpv([["af", "set", this.afGraph()]]); }
  audio(patch, cx) {
    this.save(patch, cx);
    this.act(cx, () => this.applyAudio());
  }

  poll(cx) {
    if (this.polling) return;
    this.polling = true;
    cx.spawn(async (cx) => {
      try {
        await this.pollMpv();
      } finally {
        this.polling = false;
        cx.notify();
      }
    });
  }

  async pollMpv() {
    const names = ["pause", "media-title", "time-pos", "duration", "volume", "playlist", "idle-active", "audio-bitrate",
      "audio-params/samplerate", "audio-params/channel-count"];
    const r = await this.mpv(names.map((n) => ["get_property", n]));
    if (!r) { this.state = { ...this.state, playing: false, paused: false, title: "", time: -1, length: -1, kbps: 0, khz: 0, channels: 0 }; this.queue = []; return; }
    const [pause, title, time, length, volume, list, idle, bitrate, rate, channels] = r.map((x) => x?.data);
    this.queue = (list ?? []).map((e) => ({ url: e.filename, title: this.titles[e.filename] ?? e.title ?? basename(e.filename), current: Boolean(e.current) }));
    const current = this.queue.find((e) => e.current);
    this.state = {
      playing: !idle && !pause, paused: !idle && Boolean(pause), title: idle ? "" : current?.title ?? title ?? "",
      time: time ?? -1, length: length ?? -1, volume: this.drag?.kind === "vol" ? this.state.volume : Math.round(volume ?? this.state.volume),
      kbps: bitrate ? Math.round(bitrate / 1000) : 0, khz: rate ? Math.round(rate / 1000) : 0, channels: channels ?? 0,
      origin: idle || !current ? null : this.origins[current.url] ?? "file",
    };
  }

  pollLevels(cx) {
    if (this.levelling) return;
    this.levelling = true;
    cx.spawn(async (cx) => {
      const r = await this.mpv([["get_property", "af-metadata/hp"]]);
      this.levelling = false;
      const m = r?.[0]?.data;
      if (!m) return;
      // RMS in dBFS → 0..1 over the last 60 dB.
      const lv = (k) => { const v = parseFloat(m[k]); return Number.isFinite(v) ? Math.max(0, Math.min(1, (v + 60) / 60)) : 0; };
      this.levels = [lv("lavfi.astats.1.RMS_level"), m["lavfi.astats.2.RMS_level"] ? lv("lavfi.astats.2.RMS_level") : lv("lavfi.astats.1.RMS_level")];
      cx.notify();
    });
  }

  // ---- actions ----

  act(cx, fn) {
    cx.spawn(async (cx) => {
      try { await fn(); } catch (e) { this.message = String(e.message ?? e); }
      this.poll(cx);
      cx.notify();
    });
  }

  transport(what, cx) {
    this.act(cx, async () => {
      // Stopped with a queue, Play starts it again where it stood (after stop, no entry is current).
      if ((what === "play" || what === "toggle") && !this.state.playing && !this.state.paused && this.queue.length) {
        const cur = this.queue.findIndex((e) => e.current);
        const i = cur >= 0 ? cur : Math.min(this.stoppedAt ?? 0, this.queue.length - 1);
        return this.mpv([["playlist-play-index", i], ["set_property", "pause", false]]);
      }
      if (what === "stop") this.stoppedAt = Math.max(0, this.queue.findIndex((e) => e.current));
      const cmd = { play: ["set_property", "pause", false], pause: ["set_property", "pause", true], toggle: ["cycle", "pause"],
        next: ["playlist-next", "force"], prev: ["playlist-prev", "force"], stop: ["stop", "keep-playlist"] }[what];
      if (await this.mpv([cmd])) return;
      if ((what === "play" || what === "toggle") && this.results[0]) await this.play(this.results[0], "replace");
    });
  }

  seek(frac, cx) {
    if (!(this.state.length > 0)) return;
    this.state.time = frac * this.state.length;
    this.act(cx, () => this.mpv([["seek", frac * 100, "absolute-percent"]]));
  }

  volume(v, cx) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    this.state.volume = v;
    this.act(cx, () => this.mpv([["set_property", "volume", v]]));
  }

  toggleShuffle(cx) {
    const on = !this.set.shuffle;
    this.save({ shuffle: on }, cx);
    this.act(cx, () => this.mpv([[on ? "playlist-shuffle" : "playlist-unshuffle"], ["set_property", "shuffle", on]]));
  }

  toggleRepeat(cx) {
    const on = !this.set.repeat;
    this.save({ repeat: on }, cx);
    this.act(cx, () => this.mpv([["set_property", "loop-playlist", on ? "inf" : "no"]]));
  }

  eqPreset(name, cx) {
    const custom = name === "Custom" ? this.set.custom : null;
    const bands = custom ? custom.bands : EQ_PRESETS[name];
    if (!bands) return;
    this.audio({ eq: { ...this.set.eq, on: true, bands: [...bands], preamp: custom ? custom.preamp : this.set.eq.preamp, preset: name } }, cx);
  }
  eqSaveCustom(cx) {
    this.save({ custom: { bands: [...this.set.eq.bands], preamp: this.set.eq.preamp }, eq: { ...this.set.eq, preset: "Custom" } }, cx);
  }

  // ---- what plays ----

  async fetchAudio(id) {
    const find = async () => {
      const r = await exec("sh", ["-c", 'for f in "$1"/"$2".*; do [ -e "$f" ] || continue; case "$f" in *.part|*.ytdl) continue;; esac; echo "$f"; exit 0; done; exit 1', "find", this.cache, id]);
      return r.code === 0 ? r.stdout.trim() : null;
    };
    let file = await find();
    if (file) return file;
    await exec("mkdir", ["-p", this.cache]);
    // In herdr-core, not exec: a long mix takes more than exec's 30 s.
    const run = await hc(["run", "--bg", "--json", "--no-parent", "--no-notify", "--rm", "--",
      "yt-dlp", "-q", "--no-warnings", "-f", "bestaudio", "-o", `${this.cache}/%(id)s.%(ext)s`, ytUrl(id)]);
    const address = JSON.parse(run.stdout || "{}").address;
    for (let i = 0; ; i++) {
      await exec("sleep", ["0.5"]);
      if ((file = await find())) return file;
      if (i % 4 === 3) {
        const ls = await hc(["ls", "--json"]);
        if (!(JSON.parse(ls.stdout || "{}").terminals ?? []).some((k) => k.address === address && k.state === "live")) {
          if ((file = await find())) return file;
          throw new Error("YouTube download failed");
        }
      }
    }
  }

  // Plays now (replace), after the queue (append-play), or only queues (append).
  async play(item, how) {
    if (how === "replace") this.gen = (this.gen ?? 0) + 1;
    if (!(await this.ensureMpv())) return;
    const id = ytId(item.url);
    if (id) this.message = `Loading ${item.title}…`;
    const file = id ? await this.fetchAudio(id) : item.url;
    this.titles[file] = item.title;
    localStorage.setItem("titles", JSON.stringify(this.titles));
    if (id) {
      this.origins[file] = item.origin ?? "yt";
      localStorage.setItem("origins", JSON.stringify(this.origins));
    }
    await this.mpv([["loadfile", file, how], ...(how === "append" ? [] : [["set_property", "pause", false]])]);
    this.message = "";
  }

  // Local audio: files as they are, folders searched for audio, .m3u/.m3u8 handed to mpv, .wsz added as skins.
  async addLocal(paths, cx) {
    const lists = paths.filter((p) => /\.m3u8?$/i.test(p)), skins = paths.filter((p) => /\.wsz$/i.test(p));
    const rest = paths.filter((p) => !lists.includes(p) && !skins.includes(p));
    for (const s of skins) {
      await exec("mkdir", ["-p", `${this.dir}/.skins`]);
      await exec("cp", [s, `${this.dir}/.skins/`]);
      await this.scanSkins();
      await this.useSkin(basename(s), cx);
    }
    if (!lists.length && !rest.length) return;
    if (!(await this.ensureMpv())) return;
    const wasEmpty = !this.queue.length;
    for (const l of lists) await this.mpv([["loadlist", l, "append-play"]]);
    if (rest.length) {
      const expr = AUDIO.flatMap((x, i) => [...(i ? ["-o"] : []), "-iname", `*.${x}`]);
      const r = await exec("find", [...rest, "-type", "f", "(", ...expr, ")"]);
      const files = r.stdout.split("\n").filter(Boolean).sort();
      for (const [i, f] of files.entries()) await this.mpv([["loadfile", f, i === 0 && wasEmpty ? "append-play" : "append"]]);
      this.message = files.length ? `Added ${files.length} file${files.length > 1 ? "s" : ""}` : "No audio files there";
    }
    if (wasEmpty) await this.mpv([["set_property", "pause", false]]);
    cx.notify();
  }

  addFolder(cx) {
    this.act(cx, async () => {
      const dir = await pickFolder({ prompt: "Add a music folder" });
      if (dir) await this.addLocal([dir], cx);
    });
  }

  // Saves the queue as herdr-player.m3u in a folder you pick.
  saveList(cx) {
    cx.spawn(async (cx) => {
      const dir = await pickFolder({ prompt: "Save the playlist in" });
      if (!dir) return;
      const text = ["#EXTM3U", ...this.queue.flatMap((e) => [`#EXTINF:-1,${e.title}`, e.url])].join("\n") + "\n";
      const path = `${dir}/herdr-player.m3u`;
      const old = await exec("cat", [path]).then((r) => (r.code === 0 ? r.stdout : null)).catch(() => null);
      try {
        await writeTextFile(path, text, old);
        this.message = `Saved ${path}`;
      } catch (e) {
        this.message = `Couldn't save: ${e.message ?? e}`;
      }
      cx.notify();
    });
  }

  queueAct(what, i, j, cx) {
    const cmd = { play: [["playlist-play-index", i], ["set_property", "pause", false]], remove: [["playlist-remove", i]],
      move: [["playlist-move", i, j > i ? j + 1 : j]], clear: [["playlist-clear"], ["stop"]] }[what];
    if (what === "clear") this.gen = (this.gen ?? 0) + 1;
    this.act(cx, () => this.mpv(cmd));
  }

  // A Spotify link, read from Spotify's public embed page (no account): its name, who it's by, cover art (about
  // 300 px) and songs (title, artists, length in ms).
  async spotifyLoad({ kind, id }) {
    const r = await fetch(`https://open.spotify.com/embed/${kind}/${id}`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(await r.text());
    const e = m && JSON.parse(m[1]).props?.pageProps?.state?.data?.entity;
    if (!e) throw new Error("Spotify didn't share that link (is it private?)");
    const artists = (e.artists ?? []).map((a) => a.name).join(", ");
    const songs = kind === "track" ? [{ title: e.name ?? e.title, by: artists, ms: e.duration }]
      : (e.trackList ?? []).filter((t) => t.title && t.isPlayable !== false).map((t) => ({ title: t.title, by: t.subtitle ?? "", ms: t.duration }));
    const size = (i) => i.width ?? i.maxWidth ?? 300;
    const imgs = e.coverArt?.sources ?? e.visualIdentity?.image ?? [];
    const cover = [...imgs].filter((i) => size(i) <= 320).sort((a, b) => size(b) - size(a))[0] ?? imgs[0];
    return { kind, id, name: e.title ?? e.name ?? "", by: kind === "track" ? artists : e.subtitle ?? "", cover: cover?.url, songs };
  }

  // The Spotify tab: a link's cover, name and songs, shown before anything plays.
  loadSpotify(cx) {
    const text = this.spQuery.value().trim(), link = spotifyLink(text);
    if (!link) { this.message = "That isn't a Spotify song, album, playlist or artist link."; cx.notify(); return; }
    if (this.spBusy) return;
    this.spBusy = true;
    this.message = "Reading the Spotify link…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sp = await this.spotifyLoad(link);
        // The cover, cached in a hidden folder (no mod reload); only https, and the file named by kind and id.
        if (sp.cover?.startsWith("https://")) {
          const name = `${sp.kind}-${sp.id}.jpg`;
          const r = await exec("sh", ["-c", '[ -s "$2" ] || { mkdir -p "$(dirname "$2")" && curl -sfL -m 20 -o "$2" "$1"; }; [ -s "$2" ]',
            "cover", sp.cover, `${this.dir}/.spotify/${name}`]).catch(() => ({ code: 1 }));
          if (r.code === 0) sp.coverPath = `mods/herdr-player/.spotify/${name}`;
        }
        this.sp = sp;
        this.message = sp.songs.length ? "" : "No playable songs in that link.";
        this.save({ spLink: text });
      } catch (e) {
        this.message = String(e.message ?? e);
      } finally {
        this.spBusy = false;
        cx.notify();
      }
    });
  }

  // Plays the loaded Spotify songs: all of them (i null), or one, found on YouTube.
  playSpotify(i, how, cx) {
    const songs = this.sp?.songs ?? [];
    if (!songs.length) return;
    const t = i == null ? null : songs[i];
    this.message = t ? `Finding ${t.title} on YouTube…` : `Finding ${songs.length > 1 ? `${songs.length} songs` : "it"} on YouTube…`;
    cx.notify();
    this.act(cx, async () => {
      if (!t) return this.playAll(songs, (x) => this.ytMatch(x), cx);
      const m = await this.ytMatch(t);
      if (!m) throw new Error(`Couldn't find ${t.title} on YouTube`);
      await this.play(m, how);
    });
  }

  // The same song on YouTube: the first of five results within 15 s of Spotify's length, else the first.
  async ytMatch(t) {
    const r = await exec("yt-dlp", ["--flat-playlist", "-J", "--no-warnings", `ytsearch5:${t.by} - ${t.title} audio`]);
    if (r.code !== 0) return null;
    const hits = (JSON.parse(r.stdout).entries ?? []).filter((e) => e.id);
    const want = (t.ms ?? 0) / 1000;
    const best = hits.find((e) => want > 0 && e.duration && Math.abs(e.duration - want) <= 15) ?? hits[0];
    return best ? { url: ytUrl(best.id), title: t.by ? `${t.by} - ${t.title}` : t.title, length: best.duration ?? -1, origin: "sp" } : null;
  }

  // Plays the first item at once; the rest resolve and queue one by one behind it, until something replaces or
  // clears the queue. `resolve` turns an item into something playable (or null to skip it).
  async playAll(items, resolve, cx) {
    let i = 0, first = null;
    while (i < items.length && !first) first = await resolve(items[i++]);
    if (!first) throw new Error("Couldn't find those songs on YouTube");
    await this.play(first, "replace");
    const gen = this.gen, total = items.length, rest = items.slice(i);
    cx.spawn(async (cx) => {
      for (const [k, item] of rest.entries()) {
        if (this.gen !== gen) return;
        try { const x = await resolve(item); if (x && this.gen === gen) await this.play(x, "append"); } catch {}
        this.message = k + 1 < rest.length ? `Queued ${total - rest.length + k + 1}/${total}` : "";
        cx.notify();
      }
    });
  }

  // One box for everything: a Spotify link (its songs, found on YouTube), a YouTube playlist or video link, a local
  // path, or else a YouTube search.
  submit(cx) {
    const q = this.query.value().trim();
    if (!q || this.busy) return;
    const local = q.startsWith("/") || q.startsWith("~/"), sp = spotifyLink(q);
    this.busy = true;
    this.message = local ? "" : sp ? "Reading the Spotify link…" : isYtList(q) ? "Loading playlist…" : isYtVideo(q) ? "Loading…" : "Searching…";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (sp) {
          const tracks = (await this.spotifyLoad(sp)).songs;
          if (!tracks.length) throw new Error("No playable songs in that link");
          this.message = `Finding ${tracks.length > 1 ? `${tracks.length} songs` : "it"} on YouTube…`;
          cx.notify();
          await this.playAll(tracks, (t) => this.ytMatch(t), cx);
        } else if (local) {
          await this.addLocal([q.replace(/^~/, home())], cx);
        } else if (isYtVideo(q) && !isYtList(q)) {
          await this.play({ url: q, title: q }, "replace");
        } else {
          const r = await exec("yt-dlp", ["--flat-playlist", "-J", "--no-warnings", isYtList(q) ? q : `ytsearch12:${q}`]);
          if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "yt-dlp failed");
          const entries = (JSON.parse(r.stdout).entries ?? []).filter((e) => e.id)
            .map((e) => ({ url: ytUrl(e.id), title: e.title ?? e.id, length: e.duration ?? -1, by: e.channel ?? e.uploader ?? "" }));
          if (isYtList(q) && entries.length) {
            await this.playAll(entries, async (e) => e, cx);
          } else {
            this.results = entries;
            this.message = entries.length ? "" : "Nothing found";
          }
        }
      } catch (e) {
        this.message = String(e.message ?? e);
      } finally {
        this.busy = false;
        this.poll(cx);
        cx.notify();
      }
    });
  }

  closeWindow() { closeOverlay(props().overlay); }

  // Closing the window ends the music: mpv quits with it.
  async close() {
    if (this.isStore) return;
    await exec("python3", [this.ctl, this.sock, JSON.stringify([["quit"]])]).catch(() => null);
  }

  // ---- sliders ----

  // A slider being dragged: where the press began and what it sets. Moves anywhere in the window follow it;
  // `apply(frac, done, cx)` runs on each move and once more on release with done.
  startDrag(kind, e, apply, cx) {
    cx.stop_propagation();
    if (!e.bounds?.width) return;
    this.drag = { kind, bounds: e.bounds, apply };
    this.dragTo(e.position, cx);
  }
  dragTo(pos, cx) {
    const d = this.drag;
    if (!d) return;
    const b = d.bounds;
    const f = d.kind.startsWith("eq") ? 1 - (pos.y - b.y) / b.height : (pos.x - b.x) / b.width;
    d.frac = Math.max(0, Math.min(1, f));
    d.apply(d.frac, false, cx);
    cx.notify();
  }
  endDrag(cx) {
    const d = this.drag;
    this.drag = null;
    this.pressed = null;
    this.plDrag = null;
    if (d?.frac != null) d.apply(d.frac, true, cx);
    cx.notify();
  }

  render(cx) {
    if (this.isStore) return storeRender(this);
    const req = shared("herdr-player.skin");
    if (req?.at && req.at !== this.applied) {
      this.applied = req.at;
      cx.spawn(async (cx) => { await this.scanSkins(); await this.useSkin(req.name, cx); cx.notify(); });
    }
    const sk = this.skin;
    // The skin's playlist colours, else the built-in look's.
    const pal = sk ? {
      bg: sk.pledit.normalbg ?? "#000000", text: sk.pledit.normal ?? "#00ff00", current: sk.pledit.current ?? "#ffffff",
      sel: sk.pledit.selectedbg ?? "#0000c6", dim: sk.pledit.normal ?? "#00ff00", edge: "#3c3c48", face: sk.pledit.normalbg ?? "#000000",
      font: "JetBrains Mono",
    } : { bg: "#070b08", text: "#c9c9d3", current: "#45f585", sel: "#33333c", dim: "#7d7d8c", edge: "#4a4a57", face: "#26262d", font: "JetBrains Mono" };
    const width = sk ? 275 * this.set.scale : 380;
    // The built-in look's parts sit on one backing panel, so the window behind never shows between them.
    return v_flex().id("herdr-player").w(sk ? width : width + 12).gap(sk ? 0 : 6)
      .when(!sk, (el) => el.p(6).rounded(10).bg("#1b1b21").border(1).border_color("#4a4a57"))
      .on_mouse_move((e, cx) => { if (this.drag) this.dragTo(e.position, cx); })
      .on_mouse_up("left", (_e, cx) => { if (this.drag || this.pressed || this.plDrag != null) this.endDrag(cx); })
      // A release outside the window never arrives here: leaving it ends the drag as a release would.
      .on_hover((over, cx) => { if (!over && (this.drag || this.pressed || this.plDrag != null)) this.endDrag(cx); })
      .on_drop((e, cx) => this.act(cx, () => this.addLocal(e.paths, cx)))
      .child(sk ? skinnedMain(this, sk) : classicMain(this))
      .when(!this.set.shade && this.set.eqOpen, (el) => el.child(sk?.sheets.eqmain ? skinnedEq(this, sk) : eqPanel(this, pal, width)))
      .when(!this.set.shade && this.set.plOpen, (el) => el.child(playlistPanel(this, pal, width)))
      .when(Boolean(this.message) && (this.set.shade || !this.set.plOpen), (el) => el.child(div().px(4).text_size(11).text_color(pal.dim).child(this.message)));
  }
}
