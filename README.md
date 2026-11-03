# herdr-player

A tiny retro music player that lives inside [Herdr](https://herdr.dev). YouTube, Spotify and your own files, wearing real Winamp-era skins.

![herdr-player](preview.png)

## What it does

- **YouTube.** Search, paste a video, or paste a whole playlist.
- **Spotify.** Paste a Spotify link and the Spotify app plays it.
- **Your files.** Drop a folder, some songs or an `.m3u` on it.
- **Skins.** Over 100,000 classic `.wsz` skins from the Winamp Skin Museum, one click each. Feeling lucky? Hit Random.
- **The good stuff.** A 10-band EQ with presets, balance, shuffle, repeat and a visualizer. It folds down to a single line when you only want the song title.

## Install

Ask your Herdr agent:

> Add herdr.dev/mods/dogebonker/herdr-player

It needs mpv and yt-dlp:

```sh
brew install mpv yt-dlp
```

Spotify is optional.

## Keys

| Key | Does |
| --- | --- |
| `cmd-shift-m` | Open or close the player |
| `cmd-alt-p` | Play or pause |
| `cmd-alt-n` | Next track |

They work while Herdr is in front and the player is open.

## Good to know

- YouTube tracks download before they play, so give them a few seconds. They're cached for 14 days.
- Closing the player stops the music.
- macOS only for now.

Skins come from [skins.webamp.org](https://skins.webamp.org). Not affiliated with Winamp or Webamp.

MIT licensed.
