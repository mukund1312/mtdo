"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MUSIC_PROVIDERS,
  RADIO_STATION_DETAILS,
  type ConnectionState,
  type ListeningMode,
  type MockTrack,
  type MusicProviderId,
  type RadioStation,
  providerById,
} from "./listen-data";

type RadioPlayback = "idle" | "loading" | "playing" | "paused" | "blocked" | "error";

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
};

const ListenContext = createContext<ListenState | null>(null);

export function SignalDeckListenProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<ListeningMode>("music");
  const [activeProviderId, setActiveProviderId] = useState<MusicProviderId>("apple");
  const [connections, setConnections] = useState<Record<MusicProviderId, ConnectionState>>({ apple: "disconnected", spotify: "disconnected", local: "disconnected" });
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

  const queue = useMemo(() => providerById(activeProviderId).tracks, [activeProviderId]);
  const currentTrackProviderId = useMemo<MusicProviderId | null>(() => currentTrack
    ? MUSIC_PROVIDERS.find((provider) => provider.tracks.some((track) => track.id === currentTrack.id))?.id ?? null
    : null, [currentTrack]);

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

  useEffect(() => {
    if (!musicPlaying || !currentTrack) return;
    const interval = window.setInterval(() => {
      setPosition((current) => current >= currentTrack.duration ? 0 : current + 1);
    }, 1000);
    return () => window.clearInterval(interval);
  }, [currentTrack, musicPlaying]);

  const connect = useCallback((provider: MusicProviderId) => {
    setConnections((current) => ({ ...current, [provider]: "connecting" }));
    window.setTimeout(() => {
      const unavailable = typeof navigator !== "undefined" && navigator.onLine === false;
      setConnections((current) => ({ ...current, [provider]: unavailable ? "error" : "connected" }));
    }, 520);
  }, []);

  const disconnect = useCallback((provider: MusicProviderId) => {
    setConnections((current) => ({ ...current, [provider]: "disconnected" }));
    if (provider === activeProviderId) {
      setMusicPlaying(false);
      setCurrentTrack(null);
      setPosition(0);
    }
  }, [activeProviderId]);

  const setTrack = useCallback((track: MockTrack) => {
    setCurrentTrack(track);
    setPosition(0);
    setMusicPlaying(true);
  }, []);

  const nextTrack = useCallback(() => {
    if (!queue.length) return;
    const index = currentTrack ? queue.findIndex((track) => track.id === currentTrack.id) : -1;
    setTrack(queue[(index + 1 + queue.length) % queue.length]!);
  }, [currentTrack, queue, setTrack]);

  const previousTrack = useCallback(() => {
    if (!queue.length) return;
    const index = currentTrack ? queue.findIndex((track) => track.id === currentTrack.id) : 0;
    setTrack(queue[(index - 1 + queue.length) % queue.length]!);
  }, [currentTrack, queue, setTrack]);

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
    toggleMusic: () => setMusicPlaying((playing) => !playing),
    previousTrack,
    nextTrack,
    position,
    setPosition,
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
  }), [activeProviderId, connect, connections, currentTrack, currentTrackProviderId, disconnect, favoriteStations, mode, musicPlaying, nextTrack, pauseRadio, position, previousTrack, queue, radioError, radioPlayback, repeat, selectedStation, selectStation, setTrack, shuffle, stationAtOffset, toggleRadio, volume]);

  return <ListenContext.Provider value={value}>{children}<audio ref={radioAudioRef} data-testid="signal-deck-radio-audio" preload="none" /></ListenContext.Provider>;
}

export function useSignalDeckListen(): ListenState {
  const value = useContext(ListenContext);
  if (!value) throw new Error("useSignalDeckListen must be used inside SignalDeckListenProvider");
  return value;
}
