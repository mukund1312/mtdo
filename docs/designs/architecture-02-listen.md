# Architecture 02 — Listen UI contract

## Scope

`/architecture-02` owns the Wave-2 Signal Deck **Listen** destination. Music
remains an interface-only preview: it does not call a music provider, open
OAuth, access a folder, or create a database record. Radio is the intentional
exception: it uses the Terminal's public, direct MP3 station URLs with one
persistent browser-native `HTMLAudioElement`. Existing authentication,
onboarding, Today, Session, and Review behavior are intentionally outside this
feature.

## One listening space

Listen has two top-level modes:

- **Music**: a future-provider switcher for Apple Music, Spotify, and Local
  Music. Each provider has disconnected, connecting, connected-preview, and
  error UI states. The currently shown libraries, tracks, queue, playback
  timer, and connection are all local React preview state. “Connected / demo”
  explicitly means no account or local folder has been connected.
- **Radio**: a distinct mode—not a music provider—with station browsing and a
  unified player. It translates the terminal interaction model (station,
  previous/next, volume, favorite, shuffle, repeat, shortcuts) into Signal
  Deck UI. The browser-native player starts the selected public stream, and
  native media events drive loading, buffering, playing, paused, autoplay
  blocked, and error states.

The mini player is mounted within the Architecture 02 shell and its UI state is
held above the individual deck views. It therefore remains visible and retains
its local preview state while navigating between Signal Deck surfaces, without
claiming durable or cross-session playback.

## Terminal source of truth

The terminal's Music implementation (`src/mtdo/music.py`) controls macOS Now
Playing/Spotify through native mechanisms, which must not be copied into the
web client. Its Radio implementation (`src/mtdo/radio.py`) is the source of
truth for the curated station identities. Signal Deck presents the exact eleven
names from that module:

1. Lofi Hip Hop Radio
2. EDM Pulse
3. Synthwave Nights
4. House Grooves
5. Dubstep Underground
6. Drum & Bass
7. Darksynth
8. Chillsynth
9. Vaporwave
10. Indie Pop
11. Hacker Radio

The Radio catalog keeps these URLs alongside their station names so browser
playback stays aligned with the Terminal's source-of-truth configuration.

## Future integration seam

`listen-data.ts` models the stable provider shape (`MusicProvider`) and the
station catalog. `listen-state.tsx` owns one persistent `HTMLAudioElement` for
Radio, stopping and detaching its old source before a new station begins.
Music remains an intentionally local adapter. A future backend/client
integration can replace its simulated Music connections and player actions
while preserving the components and this information architecture:

```
User → Music source (Apple Music | Spotify | Local) → unified MTDO player
User → Radio → curated stations → unified radio player
```

Do not remove the Music UI-preview labels until an actual integration exists.
OAuth, provider tokens, local-device authorization, music playback,
preference persistence, and account history need separate product and security
decisions.

## Accessibility and keyboard behavior

All controls have visible labels or accessible names. In Listen, when focus is
not in a text field: `Space` play/pause, `n` next, `p` previous, and `f`
favorite the selected radio station. The tab controls and source/station lists
use semantic buttons; range inputs retain their native keyboard behavior.
