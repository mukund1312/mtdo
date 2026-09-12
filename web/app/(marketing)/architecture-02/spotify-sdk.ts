/**
 * Minimal ambient types + the loader for Spotify's Web Playback SDK.
 *
 * Verified 2026-09-13 against Spotify's own "Getting Started" and Web
 * Playback SDK reference docs (live fetch, not memory): the script tag is
 * exactly `<script src="https://sdk.scdn.co/spotify-player.js">`, and the
 * SDK calls `window.onSpotifyWebPlaybackSDKReady` once it has loaded. Both
 * confirmed, not guessed.
 */
declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: typeof Spotify;
  }
}

// A namespace is the right shape here, not a lint dodge: `Spotify` is a
// global injected by a third-party script, both a type (Spotify.Player,
// Spotify.Track, ...) and a value (window.Spotify.Player is a real
// constructor) under one name -- exactly what ES module syntax can't
// express, and how this project's other injected-global types would be
// written if there were more than this one.
// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace Spotify {
  export interface Track {
    uri: string;
    id: string | null;
    type: "track" | "episode" | "ad";
    name: string;
    is_playable: boolean;
    album: { uri: string; name: string; images: { url: string }[] };
    artists: { uri: string; name: string }[];
  }

  export interface PlaybackState {
    position: number;
    duration: number;
    paused: boolean;
    shuffle: boolean;
    repeat_mode: 0 | 1 | 2;
    track_window: { current_track: Track; next_tracks: Track[]; previous_tracks: Track[] };
  }

  export interface PlayerInit {
    name: string;
    getOAuthToken: (callback: (token: string) => void) => void;
    volume?: number;
  }

  export declare class Player {
    constructor(options: PlayerInit);
    connect(): Promise<boolean>;
    disconnect(): void;
    addListener(event: "ready" | "not_ready", callback: (state: { device_id: string }) => void): boolean;
    addListener(event: "player_state_changed", callback: (state: PlaybackState | null) => void): boolean;
    addListener(
      event: "initialization_error" | "authentication_error" | "account_error" | "playback_error",
      callback: (state: { message: string }) => void,
    ): boolean;
    removeListener(event: string): boolean;
    togglePlay(): Promise<void>;
    pause(): Promise<void>;
    resume(): Promise<void>;
    nextTrack(): Promise<void>;
    previousTrack(): Promise<void>;
    seek(positionMs: number): Promise<void>;
    setVolume(volume: number): Promise<void>;
    getCurrentState(): Promise<PlaybackState | null>;
  }
}

let sdkPromise: Promise<typeof Spotify> | null = null;

/**
 * Loads the SDK script exactly once per page (memoized), and resolves with
 * `window.Spotify` once `onSpotifyWebPlaybackSDKReady` fires. Safe to call
 * from multiple places -- every caller shares the one in-flight load.
 */
export function loadSpotifyPlaybackSDK(): Promise<typeof Spotify> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("loadSpotifyPlaybackSDK() can only run in the browser"));
  }
  if (window.Spotify) return Promise.resolve(window.Spotify);
  if (sdkPromise) return sdkPromise;

  sdkPromise = new Promise((resolve, reject) => {
    const previousCallback = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      previousCallback?.();
      if (window.Spotify) resolve(window.Spotify);
      else reject(new Error("Spotify Web Playback SDK reported ready but window.Spotify is missing"));
    };

    const existing = document.querySelector<HTMLScriptElement>('script[src="https://sdk.scdn.co/spotify-player.js"]');
    if (existing) return; // Ready callback above will still fire.

    const script = document.createElement("script");
    script.src = "https://sdk.scdn.co/spotify-player.js";
    script.async = true;
    script.onerror = () => reject(new Error("Could not load the Spotify Web Playback SDK script."));
    document.body.appendChild(script);
  });

  return sdkPromise;
}
