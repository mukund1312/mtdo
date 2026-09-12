"use client";

// Focus Mode's music controls. Wires into the EXISTING Signal Deck listening
// system (listen-state.tsx / listen-deck.tsx) rather than building a second
// player -- see PROGRESS.md's Focus Mode frontend entry for why this screen
// mounts its own SignalDeckListenProvider instance (page.tsx) instead of the
// shared one: the Signal Deck's provider currently lives only inside
// architecture-02/page.tsx, and web/app/layout.tsx carries an explicit
// single-owner comment ("never edits this layout directly") that this task
// did not have standing to override. Trade-off, stated plainly: a track
// playing on the Signal Deck does not carry over into a Focus session, and
// vice versa -- each screen's player starts fresh. Nothing here reimplements
// playback; it is the same useSignalDeckListen() hook, restyled for the dark
// Focus surface (session.module.css) instead of the Signal Deck's own
// a02-listen chrome.

import { useState } from "react";
import { formatPlaybackTime, MUSIC_PROVIDERS, RADIO_STATION_DETAILS, providerById } from "@/app/(marketing)/architecture-02/listen-data";
import { useSignalDeckListen } from "@/app/(marketing)/architecture-02/listen-state";
import styles from "./session.module.css";

export function FocusMusicDock() {
  const listen = useSignalDeckListen();
  const [libraryOpen, setLibraryOpen] = useState(false);
  const isMusic = listen.mode === "music";
  const activeProvider = providerById(listen.activeProviderId);

  const nowPlayingTitle = isMusic
    ? listen.currentTrack?.title ?? "Nothing queued"
    : listen.selectedStation?.id ?? "No station selected";
  const nowPlayingSubtitle = isMusic
    ? listen.currentTrack ? `${listen.currentTrack.artist} · ${activeProvider.shortName}` : "Pick a track below"
    : listen.selectedStation ? listen.selectedStation.genre : "Pick a station below";
  const isPlaying = isMusic ? listen.musicPlaying : listen.radioPlayback === "playing";
  const canToggle = isMusic ? Boolean(listen.currentTrack) : Boolean(listen.selectedStation);

  return (
    <section className={styles.musicDock} aria-label="Focus sound">
      <div className={styles.musicHead}>
        <span className={styles.cardEyebrow}>Focus sound</span>
        <div className={styles.musicTabs} role="tablist" aria-label="Listening mode">
          <button
            type="button"
            role="tab"
            aria-selected={isMusic}
            className={isMusic ? styles.musicTabActive : ""}
            onClick={() => listen.setMode("music")}
          >
            Music
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={!isMusic}
            className={!isMusic ? styles.musicTabActive : ""}
            onClick={() => listen.setMode("radio")}
          >
            Radio
          </button>
        </div>
      </div>

      <div className={styles.musicNowPlaying}>
        <div>
          <b>{nowPlayingTitle}</b>
          <span>{nowPlayingSubtitle}</span>
        </div>
        <div className={styles.musicTransport}>
          <button
            type="button"
            aria-label={isMusic ? "Previous track" : "Previous station"}
            onClick={() => (isMusic ? listen.previousTrack() : listen.previousStation())}
          >
            ◀
          </button>
          <button
            type="button"
            className={styles.musicPlay}
            aria-label={isPlaying ? "Pause" : "Play"}
            disabled={!canToggle}
            onClick={() => (isMusic ? listen.toggleMusic() : listen.toggleRadio())}
          >
            {isPlaying ? "Ⅱ" : "▶"}
          </button>
          <button
            type="button"
            aria-label={isMusic ? "Next track" : "Next station"}
            onClick={() => (isMusic ? listen.nextTrack() : listen.nextStation())}
          >
            ▶
          </button>
        </div>
      </div>

      <button
        type="button"
        className={styles.musicLibraryToggle}
        aria-expanded={libraryOpen}
        onClick={() => setLibraryOpen((open) => !open)}
      >
        {libraryOpen ? "Hide" : "Change"} {isMusic ? "track" : "station"}
      </button>

      {libraryOpen && (
        <div className={styles.musicLibrary}>
          {isMusic ? (
            <>
              <div className={styles.musicSourceRow} role="tablist" aria-label="Music source">
                {MUSIC_PROVIDERS.map((provider) => (
                  <button
                    type="button"
                    key={provider.id}
                    aria-pressed={provider.id === listen.activeProviderId}
                    className={provider.id === listen.activeProviderId ? styles.musicTabActive : ""}
                    onClick={() => listen.setActiveProviderId(provider.id)}
                  >
                    {provider.shortName}
                  </button>
                ))}
              </div>
              <ol className={styles.musicTrackList}>
                {activeProvider.tracks.map((track) => (
                  <li key={track.id}>
                    <button
                      type="button"
                      className={track.id === listen.currentTrack?.id ? styles.musicTrackActive : ""}
                      onClick={() => listen.setCurrentTrack(track)}
                    >
                      <span>{track.title}</span>
                      <em>{formatPlaybackTime(track.duration)}</em>
                    </button>
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <ol className={styles.musicTrackList}>
              {RADIO_STATION_DETAILS.map((station) => (
                <li key={station.id}>
                  <button
                    type="button"
                    className={station.id === listen.selectedStation?.id ? styles.musicTrackActive : ""}
                    onClick={() => listen.selectStation(station)}
                  >
                    <span>{station.id}</span>
                    <em>{station.genre}</em>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}
