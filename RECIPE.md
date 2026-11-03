# herdr-player

A floating retro music window for Herdr. It plays YouTube through mpv, drives the Spotify app, plays local files, and can wear classic Winamp 2 `.wsz` skins picked from a built-in store.

![herdr-player](preview.png)

## What you see

A Herdr window (`kind: "window"`, `frame: "none"`, key `herdr-player`, kept across restarts), sized by its content. Top to bottom:

- **Main window.** Built-in look: 380 px wide, case `#26262d`, bevelled keys (`#33333c`, edges `#4a4a57` / `#111115`), radius 8. A title bar (`HERDR-PLAYER`, a `SKIN: <name>` chip, `STORE`, shade `▴`, close `×`). An LCD (`#070b08`) in JetBrains Mono: state glyph, a 24 px clock, a visualizer, the title as a marquee, `kbps kHz` and `MONO STEREO`, `YT SPOTIFY`, `SHUF REP` and the track length. Green `#45f585` for YouTube, amber `#ffb347` for Spotify. Then the seek bar, the keys `⏮ ▶ ⏸ ⏹ ⏭ SHUF REP EQ PL`, and VOL and BAL bars.
- **Skinned instead:** the classic 275×116 main window drawn from the skin's sprite sheets at the classic coordinates (title bar, clutter bar, digits, bitmap-font marquee, kbps/kHz, mono/stereo, volume and balance frames with thumbs, EQ/PL toggles, seek bar, transport, eject, shuffle, repeat). 1× or 2×.
- **Equalizer** (EQ toggle): built-in, an `EQ ON/OFF` chip, presets (Flat, Rock, Pop, Jazz, Classical, Bass, Vocal, and Custom once saved) and 11 vertical sliders (preamp and 60, 170, 310, 600, 1K, 3K, 6K, 12K, 14K, 16K, ±12 dB). With a skin that has `eqmain.bmp`, the skin's own equalizer.
- **Playlist** (PL toggle, open by default): `YouTube` / `Spotify` source chips, `+Dir`, `Save`, `Clear`, a search box, search results, and the queue. Skinned, it takes the skin's `pledit.txt` colours.
- Built-in, the three parts sit on one backing panel (`#1b1b21`, radius 10, 6 px padding).
- **Skin store**, a second window (key `herdr-player-store`, 600×640): `SKIN MUSEUM`, a search box, `Random`, and a 2-column grid of cards: the skin's main window (275×116) and its name, with `Get & use`, `Use` or `In use`.

## How it behaves

- **Playing:** a YouTube search shows 12 results. A click plays one, `+` queues it, shift-click queues and plays. A video link plays. A playlist link plays its first track at once and queues the rest one by one. A path starting with `/` or `~/` adds local audio. Spotify: a Spotify link or `spotify:` URI plays in the app, anything else opens the app's search. Starting one source pauses the other.
- **Display:** clicking the clock switches elapsed and remaining. Clicking the visualizer cycles bars (motion only), meter (live left/right RMS from mpv) and off. The marquee scrolls titles that don't fit, natively.
- **Sliders:** seek, volume, balance and EQ follow a drag anywhere in the window and apply on release. Leaving the window releases them. Balance snaps to centre within 8%.
- **Queue:** click plays, `×` removes, press a row and release on another to move it. `Save` writes `herdr-player.m3u` into a folder you pick. `+Dir` and the skinned eject add a folder. Dropping files, folders, `.m3u` or `.wsz` on the window adds them.
- **Skins:** the `SKIN` chip (built-in), the skinned options button, or the clutter bar's O cycles built-in → each installed skin. The clutter bar's I and the options button open the store, D toggles 2×, V cycles the visualizer. Shade (either look) folds to a one-line strip.
- **Store:** opens on the museum's own order, 24 per page, `More skins` for the next page. Search uses the museum's search. Adult skins are hidden. `Get & use` downloads the skin and switches the player to it. `Random` picks a random skin from the whole museum and uses it.
- **Keys:** `herdr-player.toggle` and `herdr-player.next` reach an open player.
- Closing the player quits mpv.

## Built from

- `mods/herdr-player/mod.json`: `place: "none"`, overlay `{ kind: "window", key: "herdr-player", keep: true, frame: "none" }` (no width: the window fits its content).
- `main.js`: the `Player` view. State, settings in `localStorage`, polling (1 s, 150 ms for the meter), actions, sliders. Opened with props `{ store: true }`, the same mod is the store (`store.js`).
- `classic.js` (built-in main window), `skin.js` (skinned main window and equalizer, the `text.bmp` font map), `panels.js` (playlist, built-in equalizer, presets).
- `mpvctl.py`: sends mpv JSON-IPC commands on `/tmp/herdr-player.sock` and prints the replies by `request_id`.
- `skin.py`: unzips a `.wsz` (names matched case-insensitively), converts each sheet to nearest-neighbour PNGs at 2× and 4× with ffmpeg, writes a 3×16 visualizer gradient and `manifest.json` (sheet sizes, `viscolor.txt`, `pledit.txt`).
- Programs: `mpv` (started with `hc run --bg --name herdr-player`), `yt-dlp` (search, playlists, downloads into `~/Library/Caches/herdr-player`, run through `hc run --bg`), `osascript` (Spotify), `ffmpeg`/`ffprobe`, `curl` (store), `python3`, `find`.
- Network: `api.webamp.org/graphql` and `r2.webampskins.org` (store), YouTube (yt-dlp).
- Herdr: `exec`, `hc`, `openOverlay`, `closeOverlay`, `props`, `shared`/`setShared` (`herdr-player.skin`: the store tells the player which skin to use), `nextCommand`, `pickFolder`, `writeTextFile`, `readTextFile`, `notify`.
- `keys.json`: `cmd-shift-m` `mod.open:herdr-player`, `cmd-alt-p` `herdr-player.toggle`, `cmd-alt-n` `herdr-player.next`.

## Watch out

- YouTube refuses mpv's own stream request (HTTP 403). Download with yt-dlp first and play the file.
- `exec` stops after 30 s: run downloads and mpv through `hc run --bg` and poll for the file.
- Saving any file in the mod folder reloads the mod, and a reload closes the window's mpv. Keep downloaded skins, converted sheets and store previews in hidden folders (`.skins/`, `.store/`).
- Herdr smooths scaled images. Pre-scale sprite sheets to the exact screen pixels (2× and 4× for retina) or pixel art blurs. A sprite is a fixed-size `overflow_hidden` box with the sheet inside at a negative offset.
- In a JS string handed to `sh -c`, a comma inside an ffmpeg filter needs `\\,`.
- mpv reports silence as `-inf`, so guard the meter against NaN. After `stop` no queue entry is current: remember the index.
- A pane receives its props through `props()`, not through `init`'s argument.
- Spotify links go into AppleScript: accept only `spotify:<kind>:<alphanumeric id>`.
- Treat museum data as untrusted: hex md5 for file names, `https://` URLs only.
- The window must not have a fixed width, or wider content (the backing panel, 2× skins) is cut off.
- macOS only: `osascript`, `~/Library/Caches`, and sheets pre-scaled for retina.

## Done when

- `herdr-app check mods/herdr-player` passes and `cmd-shift-m` opens the window.
- A YouTube search lists results, and a click plays one with time, kbps, kHz and stereo shown.
- Dropping a folder of mp3s queues them, and Play after Stop resumes the same track.
- EQ presets and balance change the sound, and the meter moves with the music.
- `Get & use` in the store switches the player to that skin, pixel-sharp, and `Random` picks a new one.
- With Spotify signed in, a pasted Spotify playlist link plays in the app and the window shows its title and time.
