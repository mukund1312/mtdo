"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MUSIC_PROVIDERS,
  RADIO_STATION_DETAILS,
  normalizeSpotifyTrack,
  type ConnectionState,
  type ListeningMode,
  type MockTrack,
  type MusicProviderId,
  type RadioStation,
  providerById,
} from "./listen-data";
import { fetchSpotifyAccessToken } from "./spotify-token";
import {
  fetchSpotifyPlaylists as fetchSpotifyPlaylistsRequest,
  fetchSpotifyPlaylistTracks,
  postSpotifyPlay,
  type SpotifyPlaylistSummary,
  type SpotifyTrackSummary,
} from "./spotify-playlists";
import {
  fetchSpotifyDevices as fetchSpotifyDevicesRequest,
  fetchSpotifyQueue as fetchSpotifyQueueRequest,
  postSpotifyTransfer,
  type SpotifyDevice,
  type SpotifyQueue,
} from "./spotify-player";
import { loadSpotifyPlaybackSDK, Spotify as SpotifyTypes } from "./spotify-sdk";

export type { SpotifyPlaylistSummary, SpotifyTrackSummary } from "./spotify-playlists";
export type { SpotifyDevice, SpotifyQueue } from "./spotify-player";

export type SpotifyRightColumnTab = "now-playing" | "queue" | "device";

export type SpotifyResourceState = "idle" | "loading" | "ready" | "error";

type RadioPlayback = "idle" | "loading" | "playing" | "paused" | "blocked" | "error";

/**
 * Real shape of GET /api/music/spotify/status (docs/architecture/api.md
 * §3i, the locked contract). `connection` is null or this exact object --
 * no token field ever appears here, on purpose.
 */
export type SpotifyConnection = {
  connectedAt: string;
  displayName: string | null;
  expired: boolean;
  /** true/false is a real signal; null means "we don't know yet," not "no." */
  premium: boolean | null;
  product: string | null;
  refreshTokenExpiresAt: string | null;
  scopes: string[];
};

export type SpotifyStatus = {
  configured: boolean;
  connected: boolean;
  connection: SpotifyConnection | null;
  missing: string[];
  provider: "spotify";
};

export type SpotifyStatusState = "loading" | "ready" | "error";

/** State of the actual Spotify.Player instance, distinct from the OAuth connection. */
export type SpotifyPlayerState = "idle" | "loading" | "ready" | "error";

type ListenState = {
  mode: ListeningMode;
  setMode: (mode: ListeningMode) => void;
  activeProviderId: MusicProviderId;
  setActiveProviderId: (provider: MusicProviderId) => void;
  connections: Record<MusicProviderId, ConnectionState>;
  connect: (provider: MusicProviderId) => void;
  disconnect: (provider: MusicProviderId) => void;
  currentTrack: MockTrack | null;
  currentTrackProviderId: MusicProviderId | null;
  setCurrentTrack: (track: MockTrack) => void;
  musicPlaying: boolean;
  toggleMusic: () => void;
  previousTrack: () => void;
  nextTrack: () => void;
  position: number;
  setPosition: (position: number) => void;
  volume: number;
  setVolume: (volume: number) => void;
  queue: MockTrack[];
  selectedStation: RadioStation | null;
  radioPlayback: RadioPlayback;
  radioError: string | null;
  selectStation: (station: RadioStation) => void;
  toggleRadio: () => void;
  pauseRadio: () => void;
  nextStation: () => void;
  previousStation: () => void;
  favoriteStations: Set<string>;
  toggleFavorite: (stationId: string) => void;
  shuffle: boolean;
  setShuffle: (enabled: boolean) => void;
  repeat: "off" | "all" | "one";
  cycleRepeat: () => void;

  // Real Spotify (docs/architecture/api.md §3i). Everything below is real:
  // no mock, no demo timeout. `apple`/`local` never touch any of this.
  spotifyStatus: SpotifyStatus | null;
  spotifyStatusState: SpotifyStatusState;
  refreshSpotifyStatus: () => Promise<boolean>;
  /** href for a real `<a>` navigation to GET /api/music/spotify/connect. */
  spotifyConnectHref: string;
  disconnectSpotify: () => Promise<void>;
  spotifyDisconnecting: boolean;
  spotifyDisconnectError: string | null;
  spotifyPlayerState: SpotifyPlayerState;
  spotifyPlayerError: string | null;
  /** True once the SDK device is ready but Spotify hasn't handed it a track --
   *  this app never calls Spotify's playback-transfer API (no scope for it),
   *  so the user has to pick "mtdo" as the active device from another
   *  Spotify client. Real, expected, and worth a distinct honest state. */
  spotifyWaitingForTransfer: boolean;
  /** The six-month authorization is genuinely dead; only a fresh Connect fixes this. */
  spotifyReconnectRequired: boolean;

  // Real Spotify (Phase 1 of the music control center, PR #172's routes):
  // playlist browse + play. `fetchSpotifyPlaylists` is idempotent and safe
  // to call repeatedly (e.g. a "Try again" button) -- it always replaces the
  // list rather than appending.
  spotifyPlaylists: SpotifyPlaylistSummary[];
  spotifyPlaylistsState: SpotifyResourceState;
  fetchSpotifyPlaylists: () => Promise<void>;
  /** The playlist currently drilled into, or null when showing the top-level
   * list. Kept as the full object (not just an id) so the track-list header
   * can show its name without a second lookup. */
  selectedSpotifyPlaylist: SpotifyPlaylistSummary | null;
  spotifyPlaylistTracks: SpotifyTrackSummary[];
  spotifyPlaylistTracksState: SpotifyResourceState;
  openSpotifyPlaylist: (playlist: SpotifyPlaylistSummary) => void;
  closeSpotifyPlaylist: () => void;
  /** Fires POST /player/play for one track within its playlist's context.
   * The SDK's own `player_state_changed` listener (already wired above)
   * picks up the resulting state change and updates `currentTrack` -- this
   * never sets it directly, so there is exactly one source of truth for
   * "what's actually playing." */
  playSpotifyTrack: (track: SpotifyTrackSummary, contextUri: string) => Promise<void>;
  spotifyPlayRequestState: "idle" | "requesting";
  spotifyPlayError: string | null;

  // Real Spotify (Phase 1, PR 3): the Now Playing / Queue / Device tab
  // switcher in column 3.
  rightColumnTab: SpotifyRightColumnTab;
  setRightColumnTab: (tab: SpotifyRightColumnTab) => void;
  spotifyQueue: SpotifyQueue;
  spotifyQueueState: SpotifyResourceState;
  refreshSpotifyQueue: () => Promise<void>;
  spotifyDevices: SpotifyDevice[];
  spotifyDevicesState: SpotifyResourceState;
  refreshSpotifyDevices: () => Promise<void>;
  transferSpotifyPlayback: (deviceId: string) => Promise<void>;
  spotifyTransferRequestState: "idle" | "requesting";
  spotifyTransferError: string | null;
};

const ListenContext = createContext<ListenState | null>(null);

export function SignalDeckListenProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ListeningMode>("music");
  const [activeProviderId, setActiveProviderId] = useState<MusicProviderId>("apple");
  // apple/local only in practice -- the "spotify" key here is never written
  // (connect()/disconnect() both branch spotify away before touching this),
  // and the exposed `connections.spotify` below is derived from the real
  // spotifyStatus instead. Typed as the full MusicProviderId map anyway so
  // `[provider]` indexing below doesn't need a redundant narrowing.
  const [demoConnections, setDemoConnections] = useState<Record<MusicProviderId, ConnectionState>>({ apple: "disconnected", spotify: "disconnected", local: "disconnected" });
  const [currentTrack, setCurrentTrack] = useState<MockTrack | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);
  const [position, setPosition] = useState(0);
  const [volume, setVolume] = useState(72);
  const [selectedStation, setSelectedStation] = useState<RadioStation | null>(null);
  const [radioPlayback, setRadioPlayback] = useState<RadioPlayback>("idle");
  const [radioError, setRadioError] = useState<string | null>(null);
  const [favoriteStations, setFavoriteStations] = useState<Set<string>>(() => new Set());
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState<"off" | "all" | "one">("off");
  const radioAudioRef = useRef<HTMLAudioElement>(null);
  const radioPlayAttemptRef = useRef(0);
  const radioTuningTimerRef = useRef<number | null>(null);
  const selectedStationRef = useRef<RadioStation | null>(null);
  const repeatRef = useRef(repeat);
  const shuffleRef = useRef(shuffle);

  // --- Real Spotify state ---------------------------------------------
  const [spotifyStatus, setSpotifyStatus] = useState<SpotifyStatus | null>(null);
  const [spotifyStatusState, setSpotifyStatusState] = useState<SpotifyStatusState>("loading");
  const [spotifyDisconnecting, setSpotifyDisconnecting] = useState(false);
  const [spotifyDisconnectError, setSpotifyDisconnectError] = useState<string | null>(null);
  const [spotifyPlayerState, setSpotifyPlayerState] = useState<SpotifyPlayerState>("idle");
  const [spotifyPlayerError, setSpotifyPlayerError] = useState<string | null>(null);
  const [spotifyWaitingForTransfer, setSpotifyWaitingForTransfer] = useState(false);
  // Set only from a real 409 { reconnectRequired: true } observed while the
  // SDK asked for a token during actual use (docs/architecture/api.md §3i
  // call-site contract point 3) -- the authoritative signal, distinct from
  // and not derived from connection.expired, which is normal access-token
  // cache staleness the token route already refreshes transparently.
  const [spotifyReconnectRequired, setSpotifyReconnectRequired] = useState(false);
  const spotifyPlayerRef = useRef<SpotifyTypes.Player | null>(null);

  // --- Real Spotify: playlist browse + play (Phase 1 control center) -----
  const [spotifyPlaylists, setSpotifyPlaylists] = useState<SpotifyPlaylistSummary[]>([]);
  const [spotifyPlaylistsState, setSpotifyPlaylistsState] = useState<SpotifyResourceState>("idle");
  const [selectedSpotifyPlaylist, setSelectedSpotifyPlaylist] = useState<SpotifyPlaylistSummary | null>(null);
  const [spotifyPlaylistTracks, setSpotifyPlaylistTracks] = useState<SpotifyTrackSummary[]>([]);
  const [spotifyPlaylistTracksState, setSpotifyPlaylistTracksState] = useState<SpotifyResourceState>("idle");
  const [spotifyPlayRequestState, setSpotifyPlayRequestState] = useState<"idle" | "requesting">("idle");
  const [spotifyPlayError, setSpotifyPlayError] = useState<string | null>(null);

  // --- Real Spotify: Now Playing / Queue / Device tabs (Phase 1, PR 3) ---
  const [rightColumnTab, setRightColumnTab] = useState<SpotifyRightColumnTab>("now-playing");
  const [spotifyQueue, setSpotifyQueue] = useState<SpotifyQueue>({ currentlyPlaying: null, queue: [] });
  const [spotifyQueueState, setSpotifyQueueState] = useState<SpotifyResourceState>("idle");
  const [spotifyDevices, setSpotifyDevices] = useState<SpotifyDevice[]>([]);
  const [spotifyDevicesState, setSpotifyDevicesState] = useState<SpotifyResourceState>("idle");
  const [spotifyTransferRequestState, setSpotifyTransferRequestState] = useState<"idle" | "requesting">("idle");
  const [spotifyTransferError, setSpotifyTransferError] = useState<string | null>(null);

  const queue = useMemo(() => providerById(activeProviderId).tracks, [activeProviderId]);
  // A real Spotify track never appears in any provider's mock `tracks` array,
  // so it has to be recognized by `isReal` rather than an id lookup -- the
  // lookup alone would silently report no provider for exactly this case.
  const currentTrackProviderId = useMemo<MusicProviderId | null>(() => {
    if (!currentTrack) return null;
    if (currentTrack.isReal) return "spotify";
    return MUSIC_PROVIDERS.find((provider) => provider.tracks.some((track) => track.id === currentTrack.id))?.id ?? null;
  }, [currentTrack]);

  useEffect(() => {
    selectedStationRef.current = selectedStation;
  }, [selectedStation]);

  useEffect(() => {
    repeatRef.current = repeat;
    shuffleRef.current = shuffle;
  }, [repeat, shuffle]);

  useEffect(() => {
    const audio = radioAudioRef.current;
    if (!audio) return;
    audio.volume = volume / 100;
  }, [volume]);

  // Real player volume follows the same one slider the mock player and radio
  // already share -- one "Vol" control for whatever is actually making sound.
  useEffect(() => {
    if (!spotifyPlayerRef.current) return;
    void spotifyPlayerRef.current.setVolume(volume / 100).catch(() => {});
  }, [volume]);

  useEffect(() => {
    const audio = radioAudioRef.current;
    if (!audio) return;
    const clearTuningTimer = () => {
      if (radioTuningTimerRef.current !== null) {
        window.clearTimeout(radioTuningTimerRef.current);
        radioTuningTimerRef.current = null;
      }
    };
    const onLoadStart = () => setRadioPlayback("loading");
    const onWaiting = () => {
      if (!audio.paused) setRadioPlayback("loading");
    };
    const onPlaying = () => {
      clearTuningTimer();
      setRadioError(null);
      setRadioPlayback("playing");
    };
    const onPause = () => {
      clearTuningTimer();
      if (audio.currentSrc && !audio.ended) setRadioPlayback("paused");
    };
    const onError = () => {
      clearTuningTimer();
      setRadioError("We could not load this station. Check your connection and try again.");
      setRadioPlayback("error");
    };
    const onEnded = () => {
      const station = selectedStationRef.current;
      if (!station) return;
      if (repeatRef.current === "one") {
        void audio.play().catch(() => setRadioPlayback("blocked"));
        return;
      }
      const index = RADIO_STATION_DETAILS.findIndex((item) => item.id === station.id);
      const choices = RADIO_STATION_DETAILS.filter((item) => item.id !== station.id);
      const next = shuffleRef.current && choices.length
        ? choices[Math.floor(Math.random() * choices.length)]!
        : RADIO_STATION_DETAILS[(index + 1) % RADIO_STATION_DETAILS.length]!;
      setSelectedStation(next);
      audio.src = next.url;
      audio.load();
      void audio.play().catch(() => setRadioPlayback("blocked"));
    };
    audio.addEventListener("loadstart", onLoadStart);
    audio.addEventListener("waiting", onWaiting);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("pause", onPause);
    audio.addEventListener("error", onError);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("loadstart", onLoadStart);
      audio.removeEventListener("waiting", onWaiting);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("pause", onPause);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("ended", onEnded);
      clearTuningTimer();
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    };
  }, []);

  // Mock position ticker (apple/local). For a real Spotify track this also
  // advances the displayed clock between the SDK's own `player_state_changed`
  // events (which fire on discrete changes, not once a second) -- but it
  // clamps at duration and waits for the next real event to correct it,
  // rather than looping back to 0 the way a demo track does.
  useEffect(() => {
    if (!musicPlaying || !currentTrack) return;
    const interval = window.setInterval(() => {
      setPosition((current) => {
        if (currentTrack.isReal) return Math.min(current + 1, currentTrack.duration);
        return current >= currentTrack.duration ? 0 : current + 1;
      });
    }, 1000);
    return () => window.clearInterval(interval);
  }, [currentTrack, musicPlaying]);

  // --- Real Spotify: status -------------------------------------------
  // A caller-invoked refresh (the panel's own "Try again" button) never
  // retries silently -- a user clicking that button wants one real attempt
  // and an honest result. The *first*, mount-time fetch below is the one
  // exception: it retries once on failure, because that fetch races the
  // anonymous session's auth cookie attaching to the very first request
  // after a fresh page load (the same race settings.spec.ts's own comments
  // document and guard against with an explicit reload) -- a real user's
  // first paint hitting this is indistinguishable from Spotify's status
  // endpoint being genuinely down, and treating it as a hard, permanent
  // error either way was the actual bug: it needlessly showed "Couldn't
  // check Spotify's status" for a fully recoverable, one-off timing issue.
  const refreshSpotifyStatus = useCallback(async (): Promise<boolean> => {
    setSpotifyStatusState("loading");
    try {
      const response = await fetch("/api/music/spotify/status", { cache: "no-store" });
      if (!response.ok) {
        setSpotifyStatusState("error");
        return false;
      }
      const body = (await response.json()) as SpotifyStatus;
      setSpotifyStatus(body);
      setSpotifyStatusState("ready");
      return true;
    } catch (err) {
      console.error("[listen] failed to load Spotify status:", err);
      setSpotifyStatusState("error");
      return false;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const ok = await refreshSpotifyStatus();
      if (!ok && !cancelled) {
        // One retry, short delay -- long enough for the auth cookie from
        // this same page load to have settled, short enough a real user
        // never perceives it as a second, separate loading state.
        window.setTimeout(() => void refreshSpotifyStatus(), 400);
      }
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-time only, refreshSpotifyStatus is stable ([] deps)
  }, []);

  // Derived, not synced via an effect: `connections.spotify` is always just
  // a reflection of the real status, so it's computed at render time rather
  // than mirrored into its own piece of state (which would need an effect
  // calling setState just to keep two copies of the same fact in agreement).
  const connections = useMemo<Record<MusicProviderId, ConnectionState>>(
    () => ({ ...demoConnections, spotify: spotifyStatus?.connected ? "connected" : "disconnected" }),
    [demoConnections, spotifyStatus],
  );

  // Real top-level navigation, not fetch() -- GET /connect answers with a 307
  // to Spotify's own consent screen, which only works as a browser
  // navigation (docs/architecture/api.md §3i). Rendered as a plain <a href>
  // in listen-deck.tsx/settings, the same pattern Calendar's own Connect
  // link already uses -- computed here once, deferred past first render like
  // this file's other window-reads, so the server-rendered href (no `next`)
  // never mismatches the client's hydrated one.
  const [spotifyConnectHref, setSpotifyConnectHref] = useState("/api/music/spotify/connect");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = `${window.location.pathname}${window.location.search}`;
      setSpotifyConnectHref(`/api/music/spotify/connect?next=${encodeURIComponent(next)}`);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const disconnectSpotify = useCallback(async () => {
    setSpotifyDisconnecting(true);
    setSpotifyDisconnectError(null);
    try {
      const response = await fetch("/api/music/spotify/disconnect", { method: "POST" });
      if (!response.ok) {
        setSpotifyDisconnectError("Couldn't disconnect Spotify. Try again.");
        return;
      }
      setCurrentTrack((current) => (current?.isReal ? null : current));
      setMusicPlaying((playing) => (currentTrack?.isReal ? false : playing));
      setPosition((pos) => (currentTrack?.isReal ? 0 : pos));
      setSpotifyReconnectRequired(false);
      setSpotifyPlaylists([]);
      setSpotifyPlaylistsState("idle");
      setSelectedSpotifyPlaylist(null);
      setSpotifyPlaylistTracks([]);
      setSpotifyPlaylistTracksState("idle");
      setSpotifyQueue({ currentlyPlaying: null, queue: [] });
      setSpotifyQueueState("idle");
      setSpotifyDevices([]);
      setSpotifyDevicesState("idle");
      setRightColumnTab("now-playing");
      await refreshSpotifyStatus();
    } catch (err) {
      console.error("[listen] failed to disconnect Spotify:", err);
      setSpotifyDisconnectError("Couldn't disconnect Spotify. Try again.");
    } finally {
      setSpotifyDisconnecting(false);
    }
  }, [currentTrack, refreshSpotifyStatus]);

  // A 401/409 result from any of these three calls means the SAME thing the
  // token route's own 401/409 branches already mean (no-session/not-
  // connected/reconnect-required) -- surfaced through the existing
  // spotifyReconnectRequired flag rather than inventing a second one, so
  // SpotifyPanel's already-built reconnect UI just works for these too.
  const handleSpotifyApiFailure = useCallback((kind: string) => {
    if (kind === "reconnect-required") {
      setSpotifyReconnectRequired(true);
      void refreshSpotifyStatus();
    } else if (kind === "not-connected") {
      void refreshSpotifyStatus();
    }
  }, [refreshSpotifyStatus]);

  const fetchSpotifyPlaylists = useCallback(async () => {
    setSpotifyPlaylistsState("loading");
    const result = await fetchSpotifyPlaylistsRequest();
    if (!result.ok) {
      console.error("[listen] failed to load Spotify playlists:", result.kind);
      handleSpotifyApiFailure(result.kind);
      setSpotifyPlaylistsState("error");
      return;
    }
    setSpotifyPlaylists(result.items);
    setSpotifyPlaylistsState("ready");
  }, [handleSpotifyApiFailure]);

  // Fetches once, automatically, the moment a real connection is confirmed --
  // the playlist browser is the default view of a connected account, not
  // something the user has to separately ask to load. Resets to idle on
  // disconnect (handled in disconnectSpotify above) so reconnecting fetches
  // fresh rather than showing a stale list.
  useEffect(() => {
    if (!spotifyStatus?.connected) return;
    if (spotifyPlaylistsState !== "idle") return;
    const timer = window.setTimeout(() => void fetchSpotifyPlaylists(), 0);
    return () => window.clearTimeout(timer);
  }, [spotifyStatus?.connected, spotifyPlaylistsState, fetchSpotifyPlaylists]);

  const openSpotifyPlaylist = useCallback((playlist: SpotifyPlaylistSummary) => {
    setSelectedSpotifyPlaylist(playlist);
    setSpotifyPlaylistTracks([]);
    setSpotifyPlaylistTracksState("loading");
    void fetchSpotifyPlaylistTracks(playlist.id).then((result) => {
      if (!result.ok) {
        console.error("[listen] failed to load playlist tracks:", result.kind);
        handleSpotifyApiFailure(result.kind);
        setSpotifyPlaylistTracksState("error");
        return;
      }
      setSpotifyPlaylistTracks(result.items);
      setSpotifyPlaylistTracksState("ready");
    });
  }, [handleSpotifyApiFailure]);

  const closeSpotifyPlaylist = useCallback(() => {
    setSelectedSpotifyPlaylist(null);
    setSpotifyPlaylistTracks([]);
    setSpotifyPlaylistTracksState("idle");
  }, []);

  const playSpotifyTrack = useCallback(async (track: SpotifyTrackSummary, contextUri: string) => {
    setSpotifyPlayRequestState("requesting");
    setSpotifyPlayError(null);
    const result = await postSpotifyPlay({ contextUri, offset: { uri: track.uri } });
    setSpotifyPlayRequestState("idle");
    if (result.ok) return;
    if (result.kind === "reconnect-required" || result.kind === "not-connected") {
      handleSpotifyApiFailure(result.kind);
      return;
    }
    // "No active device" is the common, expected case until PR 3 adds device
    // transfer -- an honest, specific message rather than a generic failure.
    setSpotifyPlayError(
      result.kind === "no-active-device"
        ? "No active Spotify device. Open Spotify somewhere and press play once, or pick \"mtdo\" from its device menu, then try again."
        : "Couldn't start playback. Try again in a moment.",
    );
  }, [handleSpotifyApiFailure]);

  const refreshSpotifyQueue = useCallback(async () => {
    setSpotifyQueueState("loading");
    const result = await fetchSpotifyQueueRequest();
    if (!result.ok) {
      console.error("[listen] failed to load Spotify queue:", result.kind);
      handleSpotifyApiFailure(result.kind);
      setSpotifyQueueState("error");
      return;
    }
    setSpotifyQueue({ currentlyPlaying: result.currentlyPlaying, queue: result.queue });
    setSpotifyQueueState("ready");
  }, [handleSpotifyApiFailure]);

  const refreshSpotifyDevices = useCallback(async () => {
    setSpotifyDevicesState("loading");
    const result = await fetchSpotifyDevicesRequest();
    if (!result.ok) {
      console.error("[listen] failed to load Spotify devices:", result.kind);
      handleSpotifyApiFailure(result.kind);
      setSpotifyDevicesState("error");
      return;
    }
    setSpotifyDevices(result.devices);
    setSpotifyDevicesState("ready");
  }, [handleSpotifyApiFailure]);

  // Fetches the tab's own data the first time it's actually opened, not
  // eagerly on connect -- unlike the playlist browser (the panel's default
  // view), Queue and Device are secondary tabs a user may never visit in a
  // given session, and both hit Spotify's Web API on every load.
  useEffect(() => {
    if (!spotifyStatus?.connected) return;
    if (rightColumnTab === "queue" && spotifyQueueState === "idle") void refreshSpotifyQueue();
    if (rightColumnTab === "device" && spotifyDevicesState === "idle") void refreshSpotifyDevices();
  }, [rightColumnTab, spotifyStatus?.connected, spotifyQueueState, spotifyDevicesState, refreshSpotifyQueue, refreshSpotifyDevices]);

  const transferSpotifyPlayback = useCallback(async (deviceId: string) => {
    setSpotifyTransferRequestState("requesting");
    setSpotifyTransferError(null);
    const result = await postSpotifyTransfer(deviceId, true);
    setSpotifyTransferRequestState("idle");
    if (result.ok) {
      // The device list's own is_active flags are now stale -- refetch
      // rather than guess which row to flip locally.
      void refreshSpotifyDevices();
      return;
    }
    if (result.kind === "reconnect-required" || result.kind === "not-connected") {
      handleSpotifyApiFailure(result.kind);
      return;
    }
    setSpotifyTransferError("Couldn't switch devices. Try again in a moment.");
  }, [handleSpotifyApiFailure, refreshSpotifyDevices]);

  // --- Real Spotify: the Web Playback SDK ------------------------------
  // Only initializes once the connection is real (`connected`) and
  // confirmed not on the free tier. `premium === false` is a real, permanent
  // platform restriction (docs/architecture/api.md §3i) -- initializing the
  // SDK there would just produce a device the user can never actually play
  // through, which is worse than an honest upfront message. `premium ===
  // null` ("unknown yet") still initializes: unknown is not a no.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!spotifyStatus?.connected) return;
    if (spotifyStatus.connection?.premium === false) return;

    let cancelled = false;
    let player: SpotifyTypes.Player | null = null;

    function initPlayer() {
      setSpotifyPlayerState("loading");
      setSpotifyPlayerError(null);
      setSpotifyReconnectRequired(false);

      loadSpotifyPlaybackSDK()
        .then((SDK) => {
          if (cancelled) return;
          const newPlayer = new SDK.Player({
            name: "mtdo",
            getOAuthToken: (callback) => {
              void fetchSpotifyAccessToken().then((result) => {
                if (result.ok) {
                  callback(result.accessToken);
                  return;
                }
                // The SDK will call this again on its own schedule; nothing
                // to hand it right now, but the four distinct states still
                // need to reach the UI so a dead connection doesn't just
                // look stuck.
                console.error("[spotify player] could not get an access token:", result);
                if (result.kind === "reconnect-required") {
                  setSpotifyReconnectRequired(true);
                  void refreshSpotifyStatus();
                } else if (result.kind === "not-connected") {
                  void refreshSpotifyStatus();
                }
              });
            },
            volume: volume / 100,
          });

          newPlayer.addListener("ready", () => {
            if (cancelled) return;
            setSpotifyPlayerState("ready");
            setSpotifyWaitingForTransfer(true);
          });
          newPlayer.addListener("not_ready", () => {
            if (cancelled) return;
            setSpotifyPlayerState("loading");
          });
          newPlayer.addListener("player_state_changed", (state) => {
            if (cancelled) return;
            if (!state) {
              setSpotifyWaitingForTransfer(true);
              return;
            }
            setSpotifyWaitingForTransfer(false);
            setCurrentTrack(normalizeSpotifyTrack(state.track_window.current_track, state.duration));
            setMusicPlaying(!state.paused);
            setPosition(Math.round(state.position / 1000));
          });
          newPlayer.addListener("initialization_error", ({ message }) => {
            if (cancelled) return;
            setSpotifyPlayerState("error");
            setSpotifyPlayerError(message);
          });
          newPlayer.addListener("authentication_error", ({ message }) => {
            if (cancelled) return;
            setSpotifyPlayerState("error");
            setSpotifyPlayerError(message);
          });
          newPlayer.addListener("account_error", ({ message }) => {
            if (cancelled) return;
            setSpotifyPlayerState("error");
            setSpotifyPlayerError(message);
          });
          newPlayer.addListener("playback_error", ({ message }) => {
            console.error("[spotify player] playback error:", message);
          });

          player = newPlayer;
          spotifyPlayerRef.current = newPlayer;
          void newPlayer.connect();
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("[spotify player] failed to load the Web Playback SDK:", err);
          setSpotifyPlayerState("error");
          setSpotifyPlayerError("Could not load the Spotify player.");
        });
    }

    // Deferred one tick, matching this codebase's established pattern for
    // effects whose body sets state (settings/page.tsx's AI/calendar status
    // loaders) -- avoids a synchronous setState-in-effect cascade.
    const kickoff = window.setTimeout(initPlayer, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(kickoff);
      player?.disconnect();
      spotifyPlayerRef.current = null;
      setSpotifyPlayerState("idle");
      setSpotifyWaitingForTransfer(false);
    };
    // volume is intentionally excluded: it's applied via its own effect above
    // rather than tearing the whole player down on every slider tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spotifyStatus?.connected, spotifyStatus?.connection?.premium, refreshSpotifyStatus]);

  const connect = useCallback((provider: MusicProviderId) => {
    if (provider === "spotify") {
      // No-op: Spotify's Connect affordance is a real <a href={spotifyConnectHref}>
      // (docs/architecture/api.md §3i requires a top-level navigation, not a
      // click handler that then navigates), so this is never actually called
      // for spotify -- kept as a safe no-op rather than removing the branch,
      // in case a future caller reaches it generically.
      return;
    }
    setDemoConnections((current) => ({ ...current, [provider]: "connecting" }));
    window.setTimeout(() => {
      const unavailable = typeof navigator !== "undefined" && navigator.onLine === false;
      setDemoConnections((current) => ({ ...current, [provider]: unavailable ? "error" : "connected" }));
    }, 520);
  }, []);

  const disconnect = useCallback((provider: MusicProviderId) => {
    if (provider === "spotify") {
      void disconnectSpotify();
      return;
    }
    setDemoConnections((current) => ({ ...current, [provider]: "disconnected" }));
    if (provider === activeProviderId) {
      setMusicPlaying(false);
      setCurrentTrack(null);
      setPosition(0);
    }
  }, [activeProviderId, disconnectSpotify]);

  const setTrack = useCallback((track: MockTrack) => {
    setCurrentTrack(track);
    setPosition(0);
    setMusicPlaying(true);
  }, []);

  const nextTrack = useCallback(() => {
    if (currentTrack?.isReal) {
      void spotifyPlayerRef.current?.nextTrack();
      return;
    }
    if (!queue.length) return;
    const index = currentTrack ? queue.findIndex((track) => track.id === currentTrack.id) : -1;
    setTrack(queue[(index + 1 + queue.length) % queue.length]!);
  }, [currentTrack, queue, setTrack]);

  const previousTrack = useCallback(() => {
    if (currentTrack?.isReal) {
      void spotifyPlayerRef.current?.previousTrack();
      return;
    }
    if (!queue.length) return;
    const index = currentTrack ? queue.findIndex((track) => track.id === currentTrack.id) : 0;
    setTrack(queue[(index - 1 + queue.length) % queue.length]!);
  }, [currentTrack, queue, setTrack]);

  const toggleMusic = useCallback(() => {
    if (currentTrack?.isReal) {
      void spotifyPlayerRef.current?.togglePlay();
      return;
    }
    setMusicPlaying((playing) => !playing);
  }, [currentTrack]);

  const seekOrSetPosition = useCallback((value: number) => {
    if (currentTrack?.isReal) {
      void spotifyPlayerRef.current?.seek(value * 1000);
      return;
    }
    setPosition(value);
  }, [currentTrack]);

  const startRadioPlayback = useCallback(async (attempt = radioPlayAttemptRef.current) => {
    const audio = radioAudioRef.current;
    if (!audio || !selectedStationRef.current) return;
    setRadioError(null);
    setRadioPlayback("loading");
    try {
      await audio.play();
    } catch (firstError) {
      if (attempt !== radioPlayAttemptRef.current) return;
      // A source replacement can reject the outgoing play promise with
      // AbortError. Retry the *current* source once in the same interaction;
      // otherwise Safari and some Chromium builds remain paused forever while
      // the UI correctly-but-unhelpfully says "Tuning".
      let error = firstError;
      let errorName = error instanceof Error ? error.name : "";
      if (errorName === "AbortError" && !audio.error) {
        try {
          await audio.play();
          return;
        } catch (retryError) {
          if (attempt !== radioPlayAttemptRef.current) return;
          error = retryError;
          errorName = error instanceof Error ? error.name : "";
        }
      }
      if (errorName === "NotAllowedError") {
        setRadioError("Your browser needs a play action before it can start this station.");
        setRadioPlayback("blocked");
        return;
      }
      // Assigning a new `src` deliberately aborts the browser's previous
      // resource-selection/play promise. That is not a failed station: the
      // new source will either emit `playing` or its own native `error` event.
      // Treating this expected handoff as a fatal error caused a false
      // “Signal unavailable” screen when changing stations in development.
      const mediaError = audio.error;
      console.info("[radio] native playback could not start", {
        name: errorName || "UnknownError",
        message: error instanceof Error ? error.message : String(error),
        mediaCode: mediaError?.code ?? null,
        station: selectedStationRef.current?.id,
        url: audio.currentSrc || audio.src,
      });
      setRadioError("We could not start this station. Check your connection and try again.");
      setRadioPlayback("error");
    }
  }, []);

  const selectStation = useCallback((station: RadioStation) => {
    const attempt = radioPlayAttemptRef.current + 1;
    radioPlayAttemptRef.current = attempt;
    setSelectedStation(station);
    selectedStationRef.current = station;
    const audio = radioAudioRef.current;
    if (!audio) return;
    // One element owns Radio. Stop only an active outgoing stream, set the
    // replacement source, then begin one deliberate resource selection before
    // asking the browser to play. This is importantly not the old
    // clear-src/load/set-src/load sequence: that intermediate empty source is
    // what can abort a user-initiated play request.
    if (!audio.paused) audio.pause();
    audio.src = station.url;
    audio.load();
    setRadioError(null);
    setRadioPlayback("loading");
    if (radioTuningTimerRef.current !== null) window.clearTimeout(radioTuningTimerRef.current);
    radioTuningTimerRef.current = window.setTimeout(() => {
      if (attempt !== radioPlayAttemptRef.current) return;
      setRadioError("This station is taking too long to tune. Try it again or choose another signal.");
      setRadioPlayback("error");
      radioTuningTimerRef.current = null;
    }, 12_000);
    void startRadioPlayback(attempt);
  }, [startRadioPlayback]);

  const stationAtOffset = useCallback((offset: number) => {
    if (!selectedStation || repeat === "one") return;
    const activeIndex = RADIO_STATION_DETAILS.findIndex((station) => station.id === selectedStation.id);
    const choices = RADIO_STATION_DETAILS.filter((station) => station.id !== selectedStation.id);
    const next = shuffle && choices.length
      ? choices[Math.floor(Math.random() * choices.length)]!
      : RADIO_STATION_DETAILS[(activeIndex + offset + RADIO_STATION_DETAILS.length) % RADIO_STATION_DETAILS.length]!;
    selectStation(next);
  }, [repeat, selectStation, selectedStation, shuffle]);

  const toggleRadio = useCallback(() => {
    const audio = radioAudioRef.current;
    if (!audio || !selectedStation) return;
    if (audio.paused) {
      radioPlayAttemptRef.current += 1;
      void startRadioPlayback(radioPlayAttemptRef.current);
      return;
    }
    audio.pause();
  }, [selectedStation, startRadioPlayback]);

  // Consumers such as Break Mode need a deterministic stop operation. A
  // toggle is not safe while a stream is buffering because its paused state
  // can still be true even though the user has already requested playback.
  const pauseRadio = useCallback(() => {
    radioPlayAttemptRef.current += 1;
    if (radioTuningTimerRef.current !== null) {
      window.clearTimeout(radioTuningTimerRef.current);
      radioTuningTimerRef.current = null;
    }
    const audio = radioAudioRef.current;
    if (audio && !audio.paused) audio.pause();
    if (selectedStationRef.current) setRadioPlayback("paused");
  }, []);

  const value = useMemo<ListenState>(() => ({
    mode,
    setMode,
    activeProviderId,
    setActiveProviderId,
    connections,
    connect,
    disconnect,
    currentTrack,
    currentTrackProviderId,
    setCurrentTrack: setTrack,
    musicPlaying,
    toggleMusic,
    previousTrack,
    nextTrack,
    position,
    setPosition: seekOrSetPosition,
    volume,
    setVolume,
    queue,
    selectedStation,
    radioPlayback,
    radioError,
    selectStation,
    toggleRadio,
    pauseRadio,
    nextStation: () => stationAtOffset(1),
    previousStation: () => stationAtOffset(-1),
    favoriteStations,
    toggleFavorite: (stationId) => setFavoriteStations((current) => {
      const next = new Set(current);
      if (next.has(stationId)) next.delete(stationId);
      else next.add(stationId);
      return next;
    }),
    shuffle,
    setShuffle,
    repeat,
    cycleRepeat: () => setRepeat((current) => current === "off" ? "all" : current === "all" ? "one" : "off"),
    spotifyStatus,
    spotifyStatusState,
    refreshSpotifyStatus,
    spotifyConnectHref,
    disconnectSpotify,
    spotifyDisconnecting,
    spotifyDisconnectError,
    spotifyPlayerState,
    spotifyPlayerError,
    spotifyWaitingForTransfer,
    spotifyReconnectRequired,
    spotifyPlaylists,
    spotifyPlaylistsState,
    fetchSpotifyPlaylists,
    selectedSpotifyPlaylist,
    spotifyPlaylistTracks,
    spotifyPlaylistTracksState,
    openSpotifyPlaylist,
    closeSpotifyPlaylist,
    playSpotifyTrack,
    spotifyPlayRequestState,
    spotifyPlayError,
    rightColumnTab,
    setRightColumnTab,
    spotifyQueue,
    spotifyQueueState,
    refreshSpotifyQueue,
    spotifyDevices,
    spotifyDevicesState,
    refreshSpotifyDevices,
    transferSpotifyPlayback,
    spotifyTransferRequestState,
    spotifyTransferError,
  }), [activeProviderId, closeSpotifyPlaylist, connect, connections, currentTrack, currentTrackProviderId, disconnect, disconnectSpotify, favoriteStations, fetchSpotifyPlaylists, mode, musicPlaying, nextTrack, openSpotifyPlaylist, pauseRadio, playSpotifyTrack, position, previousTrack, queue, radioError, radioPlayback, refreshSpotifyDevices, refreshSpotifyQueue, refreshSpotifyStatus, repeat, rightColumnTab, seekOrSetPosition, selectedSpotifyPlaylist, selectedStation, selectStation, setTrack, shuffle, spotifyConnectHref, spotifyDevices, spotifyDevicesState, spotifyDisconnectError, spotifyDisconnecting, spotifyPlayError, spotifyPlayerError, spotifyPlayerState, spotifyPlayRequestState, spotifyPlaylists, spotifyPlaylistsState, spotifyPlaylistTracks, spotifyPlaylistTracksState, spotifyQueue, spotifyQueueState, spotifyReconnectRequired, spotifyStatus, spotifyStatusState, spotifyTransferError, spotifyTransferRequestState, spotifyWaitingForTransfer, stationAtOffset, toggleMusic, toggleRadio, transferSpotifyPlayback, volume]);

  return <ListenContext.Provider value={value}>{children}<audio ref={radioAudioRef} data-testid="signal-deck-radio-audio" preload="none" /></ListenContext.Provider>;
}

export function useSignalDeckListen(): ListenState {
  const value = useContext(ListenContext);
  if (!value) throw new Error("useSignalDeckListen must be used inside SignalDeckListenProvider");
  return value;
}
