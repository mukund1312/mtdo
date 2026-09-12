"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { formatPlaybackTime, MUSIC_PROVIDERS, RADIO_STATION_DETAILS, providerById, type MockTrack, type MusicProvider, type MusicProviderId, type RadioStation } from "./listen-data";
import { useSignalDeckListen } from "./listen-state";

type ConnectionModalProvider = MusicProvider | null;

// /api/music/spotify/callback round-trips back as ?spotify=<outcome>
// (docs/architecture/api.md §3i). Plain lookup, same pattern as Settings'
// CALENDAR_OUTCOMES -- these strings are the only place a user learns why a
// consent round trip did or didn't take.
const SPOTIFY_OUTCOMES: Record<string, string> = {
  connected: "Spotify connected.",
  declined: "You declined access on Spotify's side -- nothing was connected.",
  "exchange-failed": "Spotify accepted the sign-in but the connection couldn't be completed. Try again.",
  "missing-verifier": "That sign-in didn't start here, so it was refused. Try again from this page.",
  "no-code": "Spotify didn't return an authorisation code. Try again.",
  "no-refresh-token": "Spotify didn't return a long-lived token. Try again.",
  "no-session": "Your session expired during sign-in. Sign in and try again.",
  "not-configured": "Spotify isn't configured on this server.",
  "spotify-error": "Spotify returned an error during sign-in. Try again.",
  "state-mismatch": "That sign-in didn't start here, so it was refused. Try again from this page.",
};

export function ListenDeck() {
  const listen = useSignalDeckListen();
  const [connectionModal, setConnectionModal] = useState<ConnectionModalProvider>(null);
  const [query, setQuery] = useState("");
  const [spotifyNotice, setSpotifyNotice] = useState<string | null>(null);
  const activeProvider = MUSIC_PROVIDERS.find((provider) => provider.id === listen.activeProviderId) ?? MUSIC_PROVIDERS[0]!;

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const outcome = new URLSearchParams(window.location.search).get("spotify");
      if (!outcome) return;
      setSpotifyNotice(SPOTIFY_OUTCOMES[outcome] ?? "That Spotify sign-in didn't complete.");
      void listen.refreshSpotifyStatus();
      // Strip the param so a reload doesn't re-show a stale notice.
      const url = new URL(window.location.href);
      url.searchParams.delete("spotify");
      window.history.replaceState({}, "", url);
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot read of the redirect's own query param, not a reactive value.
  }, []);
  const onModeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const nextMode = listen.mode === "music" ? "radio" : "music";
    listen.setMode(nextMode);
    window.requestAnimationFrame(() => document.getElementById(`listen-tab-${nextMode}`)?.focus());
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLElement && target.isContentEditable)) return;
      if (event.key === " ") {
        event.preventDefault();
        if (listen.mode === "music") listen.toggleMusic();
        else listen.toggleRadio();
      }
      if (event.key.toLowerCase() === "n") {
        if (listen.mode === "music") listen.nextTrack();
        else listen.nextStation();
      }
      if (event.key.toLowerCase() === "p") {
        if (listen.mode === "music") listen.previousTrack();
        else listen.previousStation();
      }
      if (event.key.toLowerCase() === "f" && listen.mode === "radio" && listen.selectedStation) listen.toggleFavorite(listen.selectedStation.id);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [listen]);

  const filteredTracks = useMemo(() => activeProvider.tracks.filter((track) => {
    const searchable = `${track.title} ${track.artist} ${track.album}`.toLowerCase();
    return searchable.includes(query.trim().toLowerCase());
  }), [activeProvider.tracks, query]);

  const openProvider = (provider: MusicProviderId) => {
    listen.setActiveProviderId(provider);
    setQuery("");
  };

  return <section className="a02-listen" aria-label="Listen">
    <header className="a02-listen-head">
      <div>
        <span className="a02-eyebrow">LISTEN / ONE SIGNAL SPACE</span>
        <h1>Stay in<br /><em>the flow.</em></h1>
        <p>Music and radio, held in one Signal Deck surface.</p>
      </div>
      <div className="a02-listen-preview-note"><i>◇</i><span>{listen.mode === "radio" ? "LIVE RADIO" : "PREVIEW MODE"}</span><small>{listen.mode === "radio" ? "Browser audio player" : "Local interactions only"}</small></div>
    </header>

    {spotifyNotice && <p className="a02-listen-empty-result" role="status">{spotifyNotice}</p>}

    <div className="a02-listen-tabs" role="tablist" aria-label="Listening mode" aria-orientation="horizontal" onKeyDown={onModeKeyDown}>
      <button type="button" id="listen-tab-music" role="tab" aria-controls="listen-panel-music" aria-selected={listen.mode === "music"} tabIndex={listen.mode === "music" ? 0 : -1} className={listen.mode === "music" ? "is-active" : ""} onClick={() => listen.setMode("music")}>Music <i>03 sources</i></button>
      <button type="button" id="listen-tab-radio" role="tab" aria-controls="listen-panel-radio" aria-selected={listen.mode === "radio"} tabIndex={listen.mode === "radio" ? 0 : -1} className={listen.mode === "radio" ? "is-active" : ""} onClick={() => listen.setMode("radio")}>Radio <i>11 stations</i></button>
    </div>

    {listen.mode === "music" ? <div id="listen-panel-music" role="tabpanel" aria-labelledby="listen-tab-music"><MusicWorkspace
      activeProvider={activeProvider}
      query={query}
      filteredTracks={filteredTracks}
      onQueryChange={setQuery}
      onOpenProvider={openProvider}
      onOpenConnection={setConnectionModal}
    /></div> : <div id="listen-panel-radio" role="tabpanel" aria-labelledby="listen-tab-radio"><RadioWorkspace /></div>}

    {connectionModal && <ConnectionModal provider={connectionModal} onClose={() => setConnectionModal(null)} />}
  </section>;
}

function MusicWorkspace({ activeProvider, query, filteredTracks, onQueryChange, onOpenProvider, onOpenConnection }: {
  activeProvider: MusicProvider;
  query: string;
  filteredTracks: MockTrack[];
  onQueryChange: (value: string) => void;
  onOpenProvider: (provider: MusicProviderId) => void;
  onOpenConnection: (provider: MusicProvider) => void;
}) {
  const listen = useSignalDeckListen();
  const connection = listen.connections[activeProvider.id];
  const isConnected = connection === "connected";

  return <div className="a02-listen-grid a02-listen-grid--music">
    <aside className="a02-listen-sources" aria-label="Music sources">
      <span className="a02-listen-section-label">MUSIC / SOURCE</span>
      {MUSIC_PROVIDERS.map((provider) => {
        const state = listen.connections[provider.id];
        const label = provider.id === "spotify"
          ? (state === "connected" ? "Connected" : listen.spotifyStatusState === "loading" ? "Checking…" : "Not connected")
          : (state === "connected" ? "Demo connected" : state === "connecting" ? "Connecting…" : state === "error" ? "Try again" : "Not connected");
        return <button key={provider.id} type="button" aria-pressed={provider.id === activeProvider.id} className={`a02-listen-source a02-listen-source--${provider.accent} ${provider.id === activeProvider.id ? "is-active" : ""}`} onClick={() => onOpenProvider(provider.id)}>
          <i>{provider.id === "apple" ? "◐" : provider.id === "spotify" ? "◉" : "▣"}</i>
          <span><b>{provider.name}</b><small>{label}</small></span>
          <em>{provider.id === activeProvider.id ? "→" : ""}</em>
        </button>;
      })}
    </aside>

    <section className="a02-listen-provider-panel">
      <div className="a02-listen-panel-top"><span className="a02-listen-section-label">{activeProvider.shortName}</span><ConnectionBadge provider={activeProvider} state={connection} /></div>
      {activeProvider.id === "spotify" ? <SpotifyPanel /> : !isConnected ? <ProviderEmptyState provider={activeProvider} state={connection} onConnect={() => onOpenConnection(activeProvider)} /> : <>
        <div className="a02-listen-library-heading"><div><span>DEMO {activeProvider.libraryLabel.toUpperCase()}</span><b>{activeProvider.libraryStats}</b></div><button type="button" onClick={() => listen.disconnect(activeProvider.id)}>Disconnect</button></div>
        <label className="a02-listen-search"><span>⌕</span><input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search your music…" aria-label="Search your music" /></label>
        <div className="a02-listen-library-tabs"><span>Recently played</span><span>Albums</span><span>Artists</span><span>Playlists</span></div>
        <TrackList tracks={filteredTracks} onPlay={listen.setCurrentTrack} currentTrackId={listen.currentTrack?.id} />
      </>}
    </section>

    <section className="a02-listen-player-column">
      <UnifiedMusicPlayer provider={activeProvider} />
      {activeProvider.id !== "spotify" && <QueuePanel tracks={listen.queue} currentTrackId={listen.currentTrack?.id} onPlay={listen.setCurrentTrack} />}
    </section>
  </div>;
}

function ConnectionBadge({ provider, state }: { provider: MusicProvider; state: "disconnected" | "connecting" | "connected" | "error" }) {
  const listen = useSignalDeckListen();
  if (provider.id === "spotify") {
    if (listen.spotifyStatusState === "loading") return <span className="a02-listen-connection is-connecting"><i />CHECKING…</span>;
    if (listen.spotifyStatus && !listen.spotifyStatus.configured) return <span className="a02-listen-connection is-error"><i />NOT CONFIGURED</span>;
    if (listen.spotifyReconnectRequired) return <span className="a02-listen-connection is-error"><i />RECONNECT NEEDED</span>;
    const copy = state === "connected" ? "CONNECTED" : "NOT CONNECTED";
    return <span className={`a02-listen-connection is-${state}`}><i />{copy}</span>;
  }
  const copy = state === "connected" ? "CONNECTED / DEMO" : state === "connecting" ? "CONNECTING…" : state === "error" ? "CONNECTION FAILED" : "NOT CONNECTED";
  return <span className={`a02-listen-connection is-${state}`}><i />{copy}</span>;
}

function ProviderEmptyState({ provider, state, onConnect }: { provider: MusicProvider; state: string; onConnect: () => void }) {
  const hasError = state === "error";
  return <div className="a02-provider-empty"><i className={`a02-provider-mark is-${provider.accent}`}>{provider.id === "apple" ? "◐" : "▣"}</i>
    <span>{provider.shortName}</span>
    <h2>{hasError ? "Connection could not start." : provider.disconnectedTitle}</h2>
    <p>{hasError ? "This UI preview checks your browser’s offline state. Try again when you are back online." : provider.disconnectedCopy}</p>
    <button type="button" className="a02-listen-primary" onClick={onConnect} disabled={state === "connecting"}>{state === "connecting" ? "Connecting…" : hasError ? "Try again" : provider.id === "local" ? "Show demo library" : `Connect ${provider.name}`}</button>
  </div>;
}

/**
 * The real Spotify surface -- everything here is a genuine backend call or a
 * genuine `Spotify.Player` state, never a demo timeout. Every degraded state
 * (unconfigured, free-tier, dead authorization, waiting for a device
 * transfer) gets its own honest copy rather than a shared "couldn't connect."
 */
function SpotifyPanel() {
  const listen = useSignalDeckListen();
  const status = listen.spotifyStatus;

  if (listen.spotifyStatusState === "loading" && !status) {
    return <div className="a02-provider-empty"><i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span><h2>Checking Spotify…</h2></div>;
  }
  if (listen.spotifyStatusState === "error") {
    return <div className="a02-provider-empty"><i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span>
      <h2>Couldn&apos;t check Spotify&apos;s status.</h2>
      <button type="button" className="a02-listen-primary" onClick={() => void listen.refreshSpotifyStatus()}>Try again</button>
    </div>;
  }
  if (!status) return null;

  if (!status.configured) {
    return <div className="a02-provider-empty"><i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span>
      <h2>Spotify isn&apos;t configured on this server yet.</h2>
      <p>
        This deployment has no Spotify credentials set
        {status.missing.length > 0 && <> (missing {status.missing.map((name, i) => <span key={name}>{i > 0 && ", "}<code>{name}</code></span>)})</>}.
        Every other listening source here still works.
      </p>
    </div>;
  }

  if (!status.connected) {
    return <div className="a02-provider-empty"><i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span>
      <h2>Connect Spotify</h2>
      <p>{providerById("spotify").disconnectedCopy} Requires Spotify Premium for in-browser playback.</p>
      <ul>{providerById("spotify").connectionBenefits.map((benefit) => <li key={benefit}>✓ {benefit}</li>)}</ul>
      {/* Real top-level navigation -- GET /connect answers with a redirect to
          Spotify's own consent screen, which only works as a browser nav. */}
      <a className="a02-listen-primary" href={listen.spotifyConnectHref}>Connect Spotify ↗</a>
    </div>;
  }

  if (listen.spotifyReconnectRequired) {
    return <div className="a02-provider-empty"><i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span>
      <h2>Reconnect Spotify</h2>
      <p>Spotify authorizations expire after six months, and yours has. Reconnect to keep listening here -- nothing else about your account is affected.</p>
      <a className="a02-listen-primary" href={listen.spotifyConnectHref}>Reconnect Spotify ↗</a>
    </div>;
  }

  if (status.connection?.premium === false) {
    return <div className="a02-provider-empty"><i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span>
      <h2>Spotify Premium required</h2>
      <p>
        {status.connection.displayName ?? "This account"} is connected, but the Web Playback SDK -- the only way this app can play
        Spotify audio -- is a Spotify Premium feature. This is a real Spotify platform restriction, not something mtdo can work
        around. Upgrading on Spotify and reconnecting will pick it up.
      </p>
      <SpotifyDisconnectButton />
    </div>;
  }

  return <div className="a02-listen-spotify-connected">
    <div className="a02-listen-library-heading">
      <div><span>SPOTIFY</span><b>{status.connection?.displayName ?? "Connected"}{status.connection?.premium === null ? " · Premium status unknown" : ""}</b></div>
      <SpotifyDisconnectButton />
    </div>
    {listen.spotifyPlayerState === "error" && <p className="a02-listen-empty-result">{listen.spotifyPlayerError ?? "The Spotify player hit an error."}</p>}
    {listen.spotifyPlayerState !== "error" && !listen.currentTrack?.isReal && <div className="a02-provider-empty">
      <i className="a02-provider-mark is-acid">◉</i><span>SPOTIFY</span>
      <h2>{listen.spotifyPlayerState === "ready" ? "Waiting for playback" : "Starting the Spotify player…"}</h2>
      <p>
        {listen.spotifyPlayerState === "ready"
          ? "This app doesn't start playback itself -- open Spotify on your phone, desktop, or web player, hit play, then pick \"mtdo\" from the device (Connect) menu."
          : "Loading the Spotify Web Playback SDK."}
      </p>
    </div>}
  </div>;
}

function SpotifyDisconnectButton() {
  const listen = useSignalDeckListen();
  return <div>
    <button type="button" disabled={listen.spotifyDisconnecting} onClick={() => void listen.disconnectSpotify()}>
      {listen.spotifyDisconnecting ? "Disconnecting…" : "Disconnect"}
    </button>
    {listen.spotifyDisconnectError && <p className="a02-listen-empty-result" role="alert">{listen.spotifyDisconnectError}</p>}
  </div>;
}

function TrackList({ tracks, onPlay, currentTrackId }: { tracks: MockTrack[]; onPlay: (track: MockTrack) => void; currentTrackId?: string }) {
  if (!tracks.length) return <div className="a02-listen-empty-result">No mock tracks match that search.</div>;
  return <ol className="a02-listen-tracks">{tracks.map((track, index) => <li key={track.id} className={currentTrackId === track.id ? "is-current" : ""}><button type="button" onClick={() => onPlay(track)} aria-label={`Play ${track.title} preview`}><span>{String(index + 1).padStart(2, "0")}</span><Artwork track={track} /><div><b>{track.title}</b><small>{track.artist} · {track.album}</small></div><time>{formatPlaybackTime(track.duration)}</time><i>{currentTrackId === track.id ? "Ⅱ" : "▶"}</i></button></li>)}</ol>;
}

function UnifiedMusicPlayer({ provider }: { provider: MusicProvider }) {
  const listen = useSignalDeckListen();
  const track = listen.currentTrack;
  const isReal = track?.isReal ?? false;
  const kind = isReal ? "Spotify" : "mock";
  const playingProvider = providerById(listen.currentTrackProviderId ?? provider.id);
  return <section className="a02-unified-player" aria-label={isReal ? "Spotify player" : "Mock music player"}>
    <div className="a02-unified-player-top"><span>NOW PLAYING</span><b aria-label={`Current music source: ${playingProvider.name}`} className={`is-${playingProvider.accent}`}><i />{playingProvider.shortName}</b></div>
    {track ? <><Artwork track={track} large /><div className="a02-unified-track"><b>{track.title}</b><span>{track.artist}</span><small>{track.album}{isReal ? "" : " · UI preview"}</small></div></> : <div className="a02-player-idle"><i>◌</i><b>Nothing queued</b><span>Choose a demo track from a connected source.</span></div>}
    <div className="a02-player-progress"><input aria-label={`Seek ${kind} track`} type="range" min="0" max={track?.duration ?? 0} value={track ? listen.position : 0} onChange={(event) => listen.setPosition(Number(event.target.value))} disabled={!track} /><span>{formatPlaybackTime(listen.position)}</span><span>{formatPlaybackTime(track?.duration ?? 0)}</span></div>
    <div className="a02-player-controls"><button type="button" onClick={listen.previousTrack} aria-label={`Previous ${kind} track`} disabled={!track}>◀</button><button type="button" className="a02-player-play" onClick={listen.toggleMusic} aria-label={listen.musicPlaying ? `Pause ${kind} track` : `Play ${kind} track`} disabled={!track}>{listen.musicPlaying ? "Ⅱ" : "▶"}</button><button type="button" onClick={listen.nextTrack} aria-label={`Next ${kind} track`} disabled={!track}>▶</button></div>
    <label className="a02-player-volume"><span>VOL</span><input aria-label="Player volume" type="range" min="0" max="100" value={listen.volume} onChange={(event) => listen.setVolume(Number(event.target.value))} /><b>{listen.volume}</b></label>
  </section>;
}

function Artwork({ track, large = false }: { track: MockTrack; large?: boolean }) {
  if (typeof track.artwork === "object") {
    // A real, arbitrary Spotify CDN URL -- next/image's remote-pattern
    // allowlist isn't worth configuring for one provider's cover art.
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={track.artwork.url} alt="" aria-hidden="true" className={`a02-track-art is-real ${large ? "is-large" : ""}`} />;
  }
  return <i aria-hidden="true" className={`a02-track-art is-${track.artwork} ${large ? "is-large" : ""}`}><span>{track.title.slice(0, 1)}</span></i>;
}

function QueuePanel({ tracks, currentTrackId, onPlay }: { tracks: MockTrack[]; currentTrackId?: string; onPlay: (track: MockTrack) => void }) {
  return <section className="a02-listen-queue"><header><span>UP NEXT</span></header>{tracks.map((track) => <button type="button" key={track.id} onClick={() => onPlay(track)} className={track.id === currentTrackId ? "is-current" : ""}><span>⋮⋮</span><b>{track.title}</b><i>{track.id === currentTrackId ? "playing" : formatPlaybackTime(track.duration)}</i></button>)}</section>;
}

function RadioWorkspace() {
  const listen = useSignalDeckListen();
  return <div className="a02-listen-grid a02-listen-grid--radio">
    <section className="a02-radio-player"><div className="a02-listen-panel-top"><span className="a02-listen-section-label">RADIO / LIVE SIGNAL</span><span className={`a02-radio-status is-${listen.radioPlayback}`}><i />{listen.radioPlayback === "playing" ? "ON AIR" : listen.radioPlayback === "loading" ? "TUNING…" : listen.radioPlayback === "paused" ? "PAUSED" : listen.radioPlayback === "blocked" ? "READY TO PLAY" : listen.radioPlayback === "error" ? "SIGNAL UNAVAILABLE" : "SELECT A STATION"}</span></div>
      {listen.radioPlayback === "error" && listen.selectedStation ? <RadioError station={listen.selectedStation} message={listen.radioError} onRetry={() => listen.selectStation(listen.selectedStation!)} /> : listen.selectedStation ? <RadioNowPlaying station={listen.selectedStation} /> : <RadioIdle />}
      <RadioControls />
    </section>
    <section className="a02-radio-stations"><header><div><span className="a02-listen-section-label">STATIONS</span><b>11 terminal frequencies</b></div></header><ol>{RADIO_STATION_DETAILS.map((station, index) => <li key={station.id}><button type="button" aria-pressed={listen.selectedStation?.id === station.id} className={listen.selectedStation?.id === station.id ? "is-active" : ""} onClick={() => listen.selectStation(station)}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{station.id}</b><small>{station.genre} · {station.signal}</small></div><i>{listen.favoriteStations.has(station.id) ? "★" : listen.selectedStation?.id === station.id ? "ON AIR" : ""}</i></button></li>)}</ol></section>
  </div>;
}

function RadioIdle() {
  return <div className="a02-radio-idle"><i>◌</i><span>RADIO</span><h2>Find a<br /><em>frequency.</em></h2><p>Select one of the 11 curated terminal stations to make it current.</p></div>;
}

function RadioNowPlaying({ station }: { station: RadioStation }) {
  const listen = useSignalDeckListen();
  return <div className="a02-radio-now"><div className={`a02-radio-analyzer ${listen.radioPlayback === "playing" ? "is-playing" : ""}`} aria-label="Live radio signal analyzer">{Array.from({ length: 26 }, (_, index) => <i key={index} />)}</div><span>NOW BROADCASTING</span><h2>{station.id}</h2><p>{station.genre} · {station.signal}</p></div>;
}

function RadioError({ station, message, onRetry }: { station: RadioStation; message: string | null; onRetry: () => void }) {
  return <div className="a02-radio-idle a02-radio-error"><i>!</i><span>SIGNAL UNAVAILABLE</span><h2>Could not tune<br /><em>{station.id}.</em></h2><p>{message ?? "We could not load this station. Check your connection and try again."}</p><button type="button" className="a02-listen-primary" onClick={onRetry}>Try again</button></div>;
}

function RadioControls() {
  const listen = useSignalDeckListen();
  const station = listen.selectedStation;
  const isFavorite = station ? listen.favoriteStations.has(station.id) : false;
  return <div className="a02-radio-controls"><div className="a02-radio-main-controls"><button type="button" aria-label="Previous station" onClick={listen.previousStation} disabled={!station}>◀</button><button type="button" className="a02-player-play" aria-label={listen.radioPlayback === "playing" ? "Pause radio" : "Play radio"} onClick={listen.toggleRadio} disabled={!station}>{listen.radioPlayback === "playing" ? "Ⅱ" : "▶"}</button><button type="button" aria-label="Next station" onClick={listen.nextStation} disabled={!station}>▶</button></div><div className="a02-radio-utility"><button type="button" aria-label="Toggle shuffle" aria-pressed={listen.shuffle} className={listen.shuffle ? "is-active" : ""} onClick={() => listen.setShuffle(!listen.shuffle)}>⤨</button><button type="button" aria-label={`Cycle repeat mode, currently ${listen.repeat}`} aria-pressed={listen.repeat !== "off"} className={listen.repeat !== "off" ? "is-active" : ""} onClick={listen.cycleRepeat}>↻<i>{listen.repeat === "one" ? "1" : ""}</i></button><button type="button" aria-label="Favorite current station" aria-pressed={isFavorite} className={isFavorite ? "is-active" : ""} onClick={() => station && listen.toggleFavorite(station.id)} disabled={!station}>★</button><label><span>VOL</span><input aria-label="Radio volume" type="range" min="0" max="100" value={listen.volume} onChange={(event) => listen.setVolume(Number(event.target.value))} /></label></div><p><kbd>space</kbd> play <kbd>n</kbd> next <kbd>p</kbd> previous <kbd>f</kbd> favorite</p></div>;
}

function ConnectionModal({ provider, onClose }: { provider: MusicProvider; onClose: () => void }) {
  const listen = useSignalDeckListen();
  const state = listen.connections[provider.id];
  const complete = state === "connected";
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => event.key === "Escape" && onClose();
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);
  return <section className="a02-listen-modal-backdrop" role="presentation" onMouseDown={onClose}><div className="a02-listen-modal" role="dialog" aria-modal="true" aria-label={`Connect ${provider.name}`} onMouseDown={(event) => event.stopPropagation()}><button ref={closeButtonRef} type="button" className="a02-listen-modal-close" aria-label="Close connection dialog" onClick={onClose}>×</button><span className="a02-eyebrow">CONNECT {provider.shortName}</span><h2>{complete ? `${provider.name} demo is ready.` : `Bring ${provider.name} into your flow.`}</h2><p>{complete ? "This frontend preview only changed local state. No account, authorization, device folder, or playback source is actually connected." : "This connection flow is a visual contract for the future provider integration. It does not contact a service or access this device."}</p><ul>{provider.connectionBenefits.map((benefit) => <li key={benefit}>✓ {benefit}</li>)}</ul><div><button type="button" className="a02-listen-primary" onClick={() => complete ? onClose() : listen.connect(provider.id)} disabled={state === "connecting"}>{complete ? "Open demo library" : state === "connecting" ? "Connecting…" : provider.id === "local" ? "Show demo library" : `Connect ${provider.name}`}</button><button type="button" className="a02-listen-secondary" onClick={onClose}>Cancel</button></div></div></section>;
}
