"use client";

import { useState } from "react";
import { Shuffle, SkipBack, Play, Pause, SkipForward, Repeat2, Volume2, Monitor, MoreVertical, Heart } from "lucide-react";

const TRACK_SECONDS = 157;

export function MusicPlayer() {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(95); // seconds, matches 1:35 in the reference
  const [volume, setVolume] = useState(70);
  const [focusMode, setFocusMode] = useState(true);
  const [liked, setLiked] = useState(false);

  const format = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    setProgress(Math.round(pct * TRACK_SECONDS));
  };

  const seekVolume = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    setVolume(Math.round(Math.max(0, Math.min(100, pct * 100))));
  };

  return (
    <footer className="rd-player">
      <div className="rd-player-track">
        <div className="rd-player-art" aria-hidden="true" />
        <div>
          <b>Unholy (feat. Kim Petras)</b>
          <span>Sam Smith</span>
        </div>
        <button
          type="button"
          aria-label={liked ? "Unlike track" : "Like track"}
          aria-pressed={liked}
          onClick={() => setLiked((v) => !v)}
          style={{ background: "none", border: "none", color: liked ? "#ff426d" : "var(--rd-text-muted)", cursor: "pointer" }}
        >
          <Heart size={16} fill={liked ? "#ff426d" : "none"} />
        </button>
      </div>

      <div className="rd-player-controls">
        <div className="rd-player-buttons">
          <button type="button" aria-label="Shuffle" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <Shuffle size={16} />
          </button>
          <button type="button" aria-label="Previous" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <SkipBack size={16} />
          </button>
          <button type="button" className="rd-player-play" aria-label={playing ? "Pause" : "Play"} onClick={() => setPlaying((v) => !v)}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <button type="button" aria-label="Next" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <SkipForward size={16} />
          </button>
          <button type="button" aria-label="Repeat" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
            <Repeat2 size={16} />
          </button>
        </div>
        <div className="rd-player-progress">
          <span>{format(progress)}</span>
          <div className="rd-player-track-bar" onClick={seek} role="slider" aria-valuemin={0} aria-valuemax={TRACK_SECONDS} aria-valuenow={progress} tabIndex={0}>
            <div className="rd-player-track-fill" style={{ width: `${(progress / TRACK_SECONDS) * 100}%` }} />
          </div>
          <span>{format(TRACK_SECONDS)}</span>
        </div>
      </div>

      <div className="rd-player-right">
        <Volume2 size={16} />
        <div className="rd-player-volume">
          <div className="rd-player-volume-track" onClick={seekVolume} role="slider" aria-valuemin={0} aria-valuemax={100} aria-valuenow={volume} tabIndex={0} aria-label="Volume">
            <div className="rd-player-volume-fill" style={{ width: `${volume}%` }} />
          </div>
        </div>
        <Monitor size={16} />
        <button type="button" aria-label="More options" style={{ background: "none", border: "none", color: "inherit", cursor: "pointer" }}>
          <MoreVertical size={16} />
        </button>
        <button type="button" className="rd-focus-mode" onClick={() => setFocusMode((v) => !v)} aria-pressed={focusMode}>
          Focus Mode <b>{focusMode ? "On" : "Off"}</b>
        </button>
      </div>
    </footer>
  );
}
