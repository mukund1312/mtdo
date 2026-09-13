/**
 * Signal Deck's listening UI is intentionally local-only for now. These
 * objects describe the shape an eventual provider adapter will populate;
 * they never represent a connected account, local file scan, or stream.
 */
export type MusicProviderId = "apple" | "spotify" | "local";
export type ListeningMode = "music" | "radio";
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/**
 * `artwork` is a fixed named palette ("violet"/"coral"/"aqua"/"acid") for the
 * three mock providers, which have no real cover art. A real Spotify track
 * does have real album art, so `artwork` also accepts `{ url }` -- one field,
 * two shapes, rather than a second track type. See listen-state.tsx's
 * `normalizeSpotifyTrack()` for why this project normalizes real Spotify
 * tracks into this exact shape instead of a MockTrack | SpotifyTrack union:
 * every consumer (TrackList, QueuePanel, UnifiedMusicPlayer, Artwork) reads
 * one shape today, and a union would have forced each of them to branch on
 * provider just to render a title and a picture.
 */
export type TrackArtwork = string | { url: string };

export type MockTrack = {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number;
  artwork: TrackArtwork;
  /** True only for a track normalized from a real Spotify.Player state. */
  isReal?: boolean;
};

export type MusicProvider = {
  id: MusicProviderId;
  name: string;
  shortName: string;
  accent: "coral" | "acid" | "aqua";
  disconnectedTitle: string;
  disconnectedCopy: string;
  connectionBenefits: string[];
  libraryLabel: string;
  libraryStats: string;
  tracks: MockTrack[];
};

/** Names deliberately match src/mtdo/radio.py's curated terminal stations. */
export const RADIO_STATIONS = [
  "Lofi Hip Hop Radio",
  "EDM Pulse",
  "Synthwave Nights",
  "House Grooves",
  "Dubstep Underground",
  "Drum & Bass",
  "Darksynth",
  "Chillsynth",
  "Vaporwave",
  "Indie Pop",
  "Hacker Radio",
] as const;

export type RadioStation = {
  id: (typeof RADIO_STATIONS)[number];
  /** Direct, public MP3 stream URL from src/mtdo/radio.py. */
  url: string;
  genre: string;
  signal: string;
};

export const RADIO_STATION_DETAILS: RadioStation[] = [
  { id: "Lofi Hip Hop Radio", url: "https://ice1.somafm.com/groovesalad-128-mp3", genre: "Lofi / study", signal: "soft loop" },
  { id: "EDM Pulse", url: "https://ice1.somafm.com/thetrip-128-mp3", genre: "Electronic", signal: "high voltage" },
  { id: "Synthwave Nights", url: "https://stream.nightride.fm/nightride.mp3", genre: "Synthwave / night drive", signal: "night signal" },
  { id: "House Grooves", url: "https://ice1.somafm.com/beatblender-128-mp3", genre: "House", signal: "four to the floor" },
  { id: "Dubstep Underground", url: "https://ice1.somafm.com/dubstep-128-mp3", genre: "Dubstep", signal: "sub pressure" },
  { id: "Drum & Bass", url: "https://ice1.somafm.com/fluid-128-mp3", genre: "Drum & bass", signal: "fast current" },
  { id: "Darksynth", url: "https://stream.nightride.fm/darksynth.mp3", genre: "Darksynth", signal: "after dark" },
  { id: "Chillsynth", url: "https://stream.nightride.fm/chillsynth.mp3", genre: "Chill synth", signal: "low light" },
  { id: "Vaporwave", url: "https://ice1.somafm.com/vaporwaves-128-mp3", genre: "Vaporwave", signal: "soft static" },
  { id: "Indie Pop", url: "https://ice1.somafm.com/poptron-128-mp3", genre: "Indie pop", signal: "open air" },
  { id: "Hacker Radio", url: "https://ice1.somafm.com/defcon-128-mp3", genre: "Experimental", signal: "coded frequency" },
];

const appleTracks: MockTrack[] = [
  { id: "apple-1", title: "Moonlit Index", artist: "Orion Vale", album: "After Hours", duration: 226, artwork: "violet" },
  { id: "apple-2", title: "Low Orbit", artist: "Mira Field", album: "Soft Signals", duration: 198, artwork: "coral" },
  { id: "apple-3", title: "Glass Notes", artist: "Kite Club", album: "Side A", duration: 244, artwork: "aqua" },
];

const spotifyTracks: MockTrack[] = [
  { id: "spotify-1", title: "Slow Signal", artist: "Cloud Frame", album: "Static Bloom", duration: 215, artwork: "acid" },
  { id: "spotify-2", title: "Night Study", artist: "Summer Department", album: "Common Room", duration: 236, artwork: "violet" },
  { id: "spotify-3", title: "Take the Long Way", artist: "Ruby Atlas", album: "Field Notes", duration: 201, artwork: "coral" },
];

const localTracks: MockTrack[] = [
  { id: "local-1", title: "Desk Lamp", artist: "North Window", album: "Room Tone", duration: 187, artwork: "aqua" },
  { id: "local-2", title: "Margins", artist: "Paper Trails", album: "Annotations", duration: 251, artwork: "acid" },
  { id: "local-3", title: "Before the Bell", artist: "The Late Lab", album: "Semester One", duration: 219, artwork: "violet" },
];

export const MUSIC_PROVIDERS: MusicProvider[] = [
  {
    id: "apple",
    name: "Apple Music",
    shortName: "APPLE MUSIC",
    accent: "coral",
    disconnectedTitle: "Connect your Apple Music account",
    disconnectedCopy: "Listen to your library and control playback from Signal Deck.",
    connectionBenefits: ["Your library", "Recently played", "Albums, artists, and playlists", "Playback controls"],
    libraryLabel: "Library",
    libraryStats: "24 albums · 186 tracks",
    tracks: appleTracks,
  },
  {
    id: "spotify",
    name: "Spotify",
    shortName: "SPOTIFY",
    accent: "acid",
    disconnectedTitle: "Connect Spotify",
    disconnectedCopy: "Bring your Spotify listening experience into Signal Deck.",
    connectionBenefits: ["Your library", "Recently played", "Playlists and artists", "Playback controls"],
    libraryLabel: "Your Library",
    libraryStats: "18 playlists · 142 tracks",
    tracks: spotifyTracks,
  },
  {
    id: "local",
    name: "Local Music",
    shortName: "LOCAL MUSIC",
    accent: "aqua",
    disconnectedTitle: "No local library connected",
    disconnectedCopy: "Choose a folder or connect a local music source when device access is available.",
    connectionBenefits: ["A device library", "Albums and artists", "Local playback controls", "Your own files"],
    libraryLabel: "Device Library",
    libraryStats: "12 albums · 143 tracks",
    tracks: localTracks,
  },
];

export function providerById(id: MusicProviderId): MusicProvider {
  return MUSIC_PROVIDERS.find((provider) => provider.id === id) ?? MUSIC_PROVIDERS[0]!;
}

export function formatPlaybackTime(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, "0")}`;
}

/**
 * Normalizes a real Spotify.Player track (from `player_state_changed`'s
 * `track_window.current_track`) into the same MockTrack shape the rest of
 * the Listen deck already renders. The SDK reports a track's duration on the
 * *playback state*, not the track object itself, so it's a separate
 * parameter here -- `durationMs` -- converted to seconds like every other
 * track in this app.
 */
export function normalizeSpotifyTrack(
  track: {
    id: string | null;
    uri: string;
    name: string;
    album: { name: string; images: { url: string }[] };
    artists: { name: string }[];
  },
  durationMs: number,
): MockTrack {
  return {
    id: track.id ?? track.uri,
    title: track.name,
    artist: track.artists.map((artist) => artist.name).join(", ") || "Unknown artist",
    album: track.album.name,
    duration: Math.round(durationMs / 1000),
    artwork: track.album.images[0] ? { url: track.album.images[0].url } : "acid",
    isReal: true,
  };
}
