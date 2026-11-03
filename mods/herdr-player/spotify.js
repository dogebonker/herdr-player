// A Spotify Premium account, through spotify_player (github.com/aome510/spotify-player), an open-source Spotify
// client that needs Premium. It runs hidden in herdr-core as `herdr-spotify`, plays real Spotify audio as the device
// "spotify-player", and answers its command line on UDP 8080: search, your playlists and liked songs, playback.
// Without Premium or an account, Spotify links play through YouTube matching instead (main.js).
//
// Written from spotify_player 0.25's source (main.rs, cli/, state/model.rs, auth.rs, client/mod.rs). It logs in
// (and starts streaming, which needs Premium) before it opens its command port, and exits if that fails. So the
// port listening means "logged in with Premium", and no command runs before it: with no instance listening, every
// spotify_player command starts a session of its own, which can wait for a browser login.

import { exec, hc, home } from "herdr";

const CACHE = () => `${home()}/.cache/spotify-player`;
export const DEVICE = "spotify-player";

// Installed, and logged in: librespot's credentials.json and a Web API token, both in spotify_player's cache.
export async function spotifyStatus() {
  const r = await exec("sh", ["-c",
    'command -v spotify_player >/dev/null || exit 2; [ -s "$1/credentials.json" ] && ls "$1"/*_token.json >/dev/null 2>&1 || exit 3',
    "status", CACHE()]).catch(() => ({ code: 2 }));
  return { installed: r.code !== 2, loggedIn: r.code === 0 };
}

// One spotify_player command. Its JSON comes back parsed, plain text as text; failures throw with its message.
export async function spotifyCli(args) {
  const r = await exec("spotify_player", args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n").pop() || `spotify_player ${args[0]} failed`);
  // It prints escaped newlines inside strings as real ones; put them back so the JSON parses.
  const out = r.stdout.trim().replace(/\r?\n/g, "\\n");
  try { return JSON.parse(out); } catch { return r.stdout.trim(); }
}

// Its command port (spotify_player's default client_port).
// ponytail: assumes the default port 8080; read client_port from app.toml if someone changes it.
async function listening() {
  const r = await exec("sh", ["-c", "lsof -nP -a -iUDP:8080 -c spotify_p >/dev/null 2>&1"]).catch(() => ({ code: 1 }));
  return r.code === 0;
}

// The hidden instance's terminal address, so closing the player can end it.
export let spotifyAddress = null;
async function findInstance() {
  const ls = await hc(["ls", "--json"]).catch(() => null);
  return (JSON.parse(ls?.stdout || "{}").terminals ?? []).find((k) => k.name === "herdr-spotify" && k.state === "live")?.address ?? null;
}

// Starts the hidden spotify_player (once) and waits up to ~20 s for its command port. True: logged in with
// Premium, ready. False: it exited (no Premium, or the login needs renewing) or never got there; it's ended then,
// so it can't sit waiting on a login nobody sees.
export async function startSpotify() {
  spotifyAddress = await findInstance();
  if (!spotifyAddress) {
    await hc(["run", "--bg", "--no-parent", "--no-notify", "--rm", "--name", "herdr-spotify", "--label", "herdr-player=1", "--", "spotify_player"]);
    spotifyAddress = await findInstance();
  }
  for (let i = 0; i < 40; i++) {
    if (await listening()) return true;
    if (!(await findInstance())) { spotifyAddress = null; return false; }
    await exec("sleep", ["0.5"]);
  }
  await stopSpotify();
  spotifyAddress = null;
  return false;
}

// Makes this machine the Spotify device. Only when you press play here: it takes over whatever plays elsewhere.
export const claimDevice = () => spotifyCli(["connect", "--name", DEVICE]);

// Ends the hidden instance (closing the player stops the music, Spotify's too).
export function stopSpotify() {
  return spotifyAddress ? exec("hc", ["kill", spotifyAddress]).catch(() => null) : null;
}

// spotify_player's own types, as the player uses them. Ids may come bare or as URIs; durations as {secs, nanos}.
const bare = (id) => String(id ?? "").split(":").pop();
const ms = (d) => (typeof d === "number" ? d : d && typeof d === "object" ? (d.secs ?? 0) * 1000 + Math.round((d.nanos ?? 0) / 1e6) : 0);
const names = (artists) => (artists ?? []).map((a) => a.name).filter(Boolean).join(", ");
export const song = (t) => ({ id: bare(t.id), title: t.name, by: names(t.artists), ms: ms(t.duration) });

// Search: songs first, then albums, playlists and artists to open.
export async function spotifySearch(q) {
  const r = await spotifyCli(["search", "--", q]);
  return {
    songs: (r.tracks ?? []).slice(0, 10).map(song),
    lists: [
      ...(r.albums ?? []).slice(0, 4).map((a) => ({ kind: "album", id: bare(a.id), name: a.name, by: names(a.artists) })),
      ...(r.playlists ?? []).slice(0, 4).map((p) => ({ kind: "playlist", id: bare(p.id), name: p.name, by: p.owner?.[0] ?? "" })),
      ...(r.artists ?? []).slice(0, 3).map((a) => ({ kind: "artist", id: bare(a.id), name: a.name, by: "" })),
    ],
  };
}

export async function spotifyPlaylists() {
  const r = await spotifyCli(["get", "key", "user-playlists"]);
  return (Array.isArray(r) ? r : []).map((p) => ({ kind: "playlist", id: bare(p.id), name: p.name, by: p.owner?.[0] ?? "" }));
}

export async function spotifyLiked() {
  const r = await spotifyCli(["get", "key", "user-liked-tracks"]);
  return { kind: "liked", id: "liked", name: "Liked Songs", by: "You", songs: (Array.isArray(r) ? r : []).map(song) };
}

// A playlist, album or artist through the account: private playlists too, which Spotify's public page can't show.
export async function spotifyItem(kind, id) {
  const r = await spotifyCli(["get", "item", kind, "--id", id]);
  const c = r?.Playlist ?? r?.Album ?? r?.Artist ?? r;
  const head = c.playlist ?? c.album ?? c.artist ?? {};
  return {
    kind, id, name: head.name ?? "", by: kind === "playlist" ? head.owner?.[0] ?? "" : names(head.artists),
    songs: (c.tracks ?? c.top_tracks ?? []).map(song),
  };
}

// The playback now, in the player's terms (null: nothing playing on Spotify).
export async function spotifyNow() {
  const p = await spotifyCli(["get", "key", "playback"]).catch(() => null);
  if (!p || typeof p !== "object" || !p.item) return null;
  return {
    playing: Boolean(p.is_playing), paused: !p.is_playing,
    title: [names(p.item.artists), p.item.name].filter(Boolean).join(" - "),
    time: (p.progress_ms ?? 0) / 1000, length: (p.item.duration_ms ?? ms(p.item.duration)) / 1000,
    volume: p.device?.volume_percent ?? 70, shuffle: Boolean(p.shuffle_state), repeat: p.repeat_state ?? "off",
    kbps: 0, khz: 0, channels: 2, origin: "sp",
  };
}
