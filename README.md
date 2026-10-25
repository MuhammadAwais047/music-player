# Cadence — Generative Music Player

A vinyl-styled music player with five original tracks that are synthesised in the browser at play time. There are no audio files and no network requests for sound — every note is generated with the Web Audio API.

**Live demo:** https://muhammadawais047.github.io/music-player/

## Tracks

| # | Title | Artist | Style | BPM | Length |
|---|-------|--------|-------|-----|--------|
| 1 | Neon Drift | Vela | Synthwave | 100 | 0:32 |
| 2 | Rainy Window | Mono Lake | Lo-fi | 76 | 0:36 |
| 3 | Deep Field | North Signal | Ambient | 56 | 0:40 |
| 4 | Pixel Sunrise | Glass Hours | Chiptune | 124 | 0:32 |
| 5 | Midnight Transit | Vela | Downtempo | 92 | 0:36 |

All five are original compositions written for this project.

## Features

- **Nothing to download.** Tracks are rendered on demand with `OfflineAudioContext`, then cached (up to three) so replays start instantly.
- **Animated vinyl deck.** CSS-drawn cover art, rotating record, stylus, and a live frequency visualiser driven by an `AnalyserNode`.
- **Library tools.** Search by title, artist, or mood; filter by genre or liked tracks.
- **Queue and transport.** Up-next list, skip ahead, shuffle, and repeat off / all / one.
- **System integration.** Media Session metadata and artwork, so hardware media keys and lock-screen controls work where supported.
- **Keyboard-first.** Space, arrows, `N`/`P`, `S`, `R`, `M`, `/`, and `Esc`.
- **Your settings stick.** Likes, volume, last track, shuffle, and repeat are saved in `localStorage`.
- **Responsive and accessible.** Layouts for desktop down to 320 px, visible focus states, ARIA labels, polite live status, and reduced-motion support.

## How the audio works

1. Each track is a small arrangement of note events — bass, pads, arpeggios, leads, and drums — written as data.
2. An `OfflineAudioContext` (mono, 32 kHz) renders the arrangement using long-lived sequencer voices: one oscillator per melodic line with scheduled frequency and gain automation, one noise source for all percussion, and one oscillator for all kick hits. This keeps a 32–40 second render around one to two seconds.
3. The rendered buffer is normalised to a 0.85 peak, faded in and out, and cached.
4. Playback runs through a shared `AudioContext`: buffer source → analyser → master gain → destination. Seeking restarts the source at the requested offset; Media Session position state stays in sync.

No libraries, no build step, no samples.

## Controls

| Input | Action |
|-------|--------|
| `Space` | Play / pause |
| `←` / `→` | Seek 5 seconds |
| `↑` / `↓` | Volume |
| `N` / `P` | Next / previous track |
| `S` | Shuffle |
| `R` | Repeat off → all → one |
| `M` | Mute |
| `/` | Focus search |
| `Esc` | Clear search or leave the field |

## Run locally

Any static file server works:

```bash
python -m http.server 8000
```

Then open <http://localhost:8000>.

The first play of each track shows a short "Composing…" state while the buffer is rendered.

## Project structure

```
music-player/
├── index.html   # deck, library, queue markup
├── styles.css   # theme, vinyl art, responsive layout
└── app.js       # synth engine, compositions, player state, UI
```

## Browser support

Current Chrome, Edge, Firefox, and Safari. The Web Audio API is required; if it is unavailable the player reports it in the status line.

## License

MIT — see [LICENSE](LICENSE). © 2026 Muhammad Awais
