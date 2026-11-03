// herdr-player: a small retro music window. YouTube plays through mpv; Spotify is the desktop app, driven by
// AppleScript. The window is the remote: mpv runs in herdr-core as `herdr-player` and stops when the window closes.
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

// ponytail: one fixed socket, so one player per user; a per-window socket if two are ever wanted.
const SOCK = "/tmp/herdr-player.sock";
const EQ_FREQS = [60, 170, 310, 600, 1000, 3000, 6000, 12000, 14000, 16000];
const AUDIO = ["mp3", "flac", "ogg", "opus", "m4a", "aac", "wav", "aiff", "webm", "wma"];

const ytUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
const ytId = (url) => /(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/.exec(url)?.[1] ?? null;
const isYtList = (q) => /^https?:\/\//.test(q) && /[?&]list=|\/playlist/.test(q);
const isYtVideo = (q) => /^https?:\/\/(www\.|m\.|music\.)?(youtube\.com|youtu\.be)\//.test(q);
const basename = (p) => p.split("/").pop().replace(/\.[^.]+$/, "");
// open.spotify.com/playlist/ID?si=… → spotify:playlist:ID. Checked, since it goes into AppleScript: kind and id only.
const spotifyUri = (q) => {
  if (/^spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]+$/.test(q)) return q;
  const m = /open\.spotify\.com\/(?:intl-\w+\/)?(track|album|playlist|artist|episode|show)\/([A-Za-z0-9]+)/.exec(q);
  return m ? `spotify:${m[1]}:${m[2]}` : null;
};

async function osa(script) {
  const r = await exec("osascript", ["-e", script]).catch(() => null);
  return r && r.code === 0 ? r.stdout.trim() : null;
}
const spotify = (cmd) => osa(`if application "Spotify" is running then tell application "Spotify" to ${cmd}`);

// Settings kept per window copy; anything missing takes its default.
const DEFAULTS = {
  source: "yt", skin: null, scale: 1, vis: "bars", remaining: false, shuffle: false, repeat: false,
  balance: 0, eq: { on: false, preamp: 0, bands: Array(10).fill(0), preset: "Flat" }, custom: null,
  eqOpen: false, plOpen: true, shade: false,
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
    this.message = "";
    this.busy = false;
    this.pressed = null;
    this.drag = null;
    this.plDrag = null;
    this.skin = null;
    this.skins = [];
    this.query = InputState.new({ placeholder: "Search YouTube, paste a link, a folder or an .m3u path" });
    this.query.on("submit", (_e, cx) => this.submit(cx));
    this.dir = `${home()}/.config/herdr-app/mods/herdr-player`;
    this.ctl = `${this.dir}/mpvctl.py`;
    this.cache = `${home()}/Library/Caches/herdr-player`;
    if (this.isStore) return storeInit(this, cx);
    // A skin request from the store (shared state); one already there when the window opens is old news.
    this.applied = shared("herdr-player.skin")?.at ?? 0;
    // ponytail: cache trimmed by age (14 days) only, a size cap if long mixes fill the disk.
    exec("find", [this.cache, "-type", "f", "-mtime", "+14", "-delete"]).catch(() => null);
    cx.timer.every(1000, (cx) => this.poll(cx));
    // The level meter reads mpv's levels a few times a second, only while it shows and plays.
    cx.timer.every(150, (cx) => { if (this.set.vis === "meter" && this.state.playing && this.set.source === "yt" && !this.set.shade) this.pollLevels(cx); });
    // Keys from keys.json (`herdr-player.toggle`, `herdr-player.next`); they reach the player while its window is open.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle" || c === "next") this.transport(c, cx);
      }
    });
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
    const r = await exec("python3", [this.ctl, SOCK, JSON.stringify(cmds)]).catch(() => null);
    if (!r || r.code !== 0) return null;
    try { return JSON.parse(r.stdout); } catch { return null; }
  }

  ensureMpv() {
    this.starting ??= this.startMpv().finally(() => { this.starting = null; });
    return this.starting;
  }
  async startMpv() {
    if (await this.mpv([["get_property", "idle-active"]])) return true;
    await hc(["run", "--bg", "--no-parent", "--no-notify", "--rm", "--name", "herdr-player", "--label", "herdr-player=1", "--",
      "mpv", "--idle=yes", "--no-video", "--no-terminal", "--force-window=no", `--input-ipc-server=${SOCK}`,
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
        if (this.set.source === "yt") await this.pollMpv();
        else await this.pollSpotify();
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

  async pollSpotify() {
    const out = await spotify(`return (player state as string) & "\n" & (name of current track) & " - " & (artist of current track) & "\n" & ((duration of current track) / 1000) & "\n" & (player position) & "\n" & (sound volume)`);
    if (!out) { this.state = { ...this.state, playing: false, paused: false, title: "Spotify isn't running", time: -1, length: -1, kbps: 0, khz: 0, channels: 0 }; return; }
    const [st, title, length, time, volume] = out.split("\n");
    const num = (s) => parseFloat(String(s).replace(",", "."));
    this.state = { playing: st === "playing", paused: st === "paused", title, time: num(time), length: num(length), volume: Math.round(num(volume)), kbps: 0, khz: 0, channels: 2 };
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
      if (this.set.source === "sp") {
        if (what === "play" && !(await osa(`application "Spotify" is running`) === "true")) return exec("open", ["-a", "Spotify"]);
        return spotify({ play: "play", pause: "pause", toggle: "playpause", next: "next track", prev: "previous track", stop: "pause" }[what]);
      }
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
    this.act(cx, () => this.set.source === "sp"
      ? spotify(`set player position to ${(frac * this.state.length).toFixed(1)}`)
      : this.mpv([["seek", frac * 100, "absolute-percent"]]));
  }

  volume(v, cx) {
    v = Math.max(0, Math.min(100, Math.round(v)));
    this.state.volume = v;
    this.act(cx, () => this.set.source === "sp" ? spotify(`set sound volume to ${v}`) : this.mpv([["set_property", "volume", v]]));
  }

  toggleShuffle(cx) {
    const on = !this.set.shuffle;
    this.save({ shuffle: on }, cx);
    this.act(cx, () => this.set.source === "sp" ? spotify(`set shuffling to ${on}`)
      : this.mpv([[on ? "playlist-shuffle" : "playlist-unshuffle"], ["set_property", "shuffle", on]]));
  }

  toggleRepeat(cx) {
    const on = !this.set.repeat;
    this.save({ repeat: on }, cx);
    this.act(cx, () => this.set.source === "sp" ? spotify(`set repeating to ${on}`) : this.mpv([["set_property", "loop-playlist", on ? "inf" : "no"]]));
  }

  setSource(src, cx) {
    this.save({ source: src }, cx);
    this.query.set_placeholder?.(src === "yt" ? "Search YouTube, paste a link, a folder or an .m3u path" : "Search Spotify, or paste a Spotify link");
    this.poll(cx);
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

  // Plays now (replace), after the queue (append-play), or only queues (append). Spotify pauses: one plays at a time.
  async play(item, how) {
    if (how === "replace") this.gen = (this.gen ?? 0) + 1;
    if (!(await this.ensureMpv())) return;
    const id = ytId(item.url);
    if (id) this.message = `Loading ${item.title}…`;
    const file = id ? await this.fetchAudio(id) : item.url;
    this.titles[file] = item.title;
    localStorage.setItem("titles", JSON.stringify(this.titles));
    if (how !== "append") await spotify("pause");
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
    if (this.set.source !== "yt") this.setSource("yt", cx);
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

  // YouTube: a playlist link queues it all, a video link plays it, a local path adds it, anything else searches.
  // Spotify: a link or URI plays in the app, anything else opens the app's search.
  submit(cx) {
    const q = this.query.value().trim();
    if (!q || this.busy) return;
    const local = q.startsWith("/") || q.startsWith("~/");
    this.busy = true;
    this.message = this.set.source === "yt" && !local ? (isYtList(q) ? "Loading playlist…" : isYtVideo(q) ? "Loading…" : "Searching…") : "";
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        if (this.set.source === "sp") {
          const uri = spotifyUri(q);
          if (!(await osa(`application "Spotify" is running`) === "true")) await exec("open", ["-a", "Spotify"]);
          await this.mpv([["set_property", "pause", true]]);
          if (uri) await osa(`tell application "Spotify" to play track "${uri}"`);
          else await exec("open", [`spotify:search:${encodeURIComponent(q)}`]);
          this.message = uri ? "" : "Search opened in Spotify";
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
            // The first plays as soon as it's down; the rest download one by one behind it, until something
            // replaces or clears the queue.
            await this.play(entries[0], "replace");
            const gen = this.gen;
            cx.spawn(async (cx) => {
              for (const [i, e] of entries.slice(1).entries()) {
                if (this.gen !== gen) return;
                try { await this.play(e, "append"); } catch {}
                this.message = i + 2 < entries.length ? `Queued ${i + 2}/${entries.length}` : "";
                cx.notify();
              }
            });
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
    await exec("python3", [this.ctl, SOCK, JSON.stringify([["quit"]])]).catch(() => null);
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
