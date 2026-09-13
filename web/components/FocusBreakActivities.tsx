"use client";

import { useEffect, useState } from "react";
import { useSignalDeckListen } from "@/app/(marketing)/architecture-02/listen-state";
import { RADIO_STATION_DETAILS } from "@/app/(marketing)/architecture-02/listen-data";
import styles from "./FocusBreakActivities.module.css";

type Activity = "breathe" | "stretch";

const BREAK_NOTES = [
  "Your mind earned a pause.",
  "Step away. Breathe. Reset.",
  "You don't have to be productive every minute.",
  "Let your attention rest.",
  "A short pause makes room for better focus.",
] as const;

function formatRemaining(totalSeconds: number) {
  const safe = Math.max(0, Math.ceil(totalSeconds));
  return `${String(Math.floor(safe / 60)).padStart(2, "0")}:${String(safe % 60).padStart(2, "0")}`;
}

export function FocusBreakActivities({ endsAt, onResume, isResuming }: { endsAt: number; onResume: () => void; isResuming: boolean }) {
  const listen = useSignalDeckListen();
  const [activity, setActivity] = useState<Activity>("breathe");
  const [now, setNow] = useState(() => Date.now());
  const [breathStartedAt] = useState(() => Date.now());
  const [noteIndex, setNoteIndex] = useState(0);
  const elapsed = Math.max(0, now - breathStartedAt);
  const breathNumber = Math.min(3, Math.floor(elapsed / 8000) + 1);
  const withinBreath = elapsed % 8000;
  const breathCopy = breathNumber >= 3 && elapsed >= 24000
    ? "Three breaths complete"
    : withinBreath < 4000 ? "Breathe in" : "Breathe out";

  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setNoteIndex((current) => (current + 1) % BREAK_NOTES.length);
    }, 6500);
    return () => window.clearInterval(interval);
  }, []);

  // Three quiet breaths lead naturally into the posture reset, while the user
  // remains free to choose either activity at any point.
  useEffect(() => {
    if (activity !== "breathe") return;
    const remainingUntilReset = Math.max(0, 24000 - (Date.now() - breathStartedAt));
    const timeout = window.setTimeout(() => setActivity("stretch"), remainingUntilReset);
    return () => window.clearTimeout(timeout);
  }, [activity, breathStartedAt]);

  const remaining = Math.max(0, (endsAt - now) / 1000);
  const soothingStation = RADIO_STATION_DETAILS.find((station) => station.id === "Chillsynth")!;
  const soothingIsActive = listen.selectedStation?.id === soothingStation.id;
  const soothingIsPlaying = soothingIsActive && (listen.radioPlayback === "playing" || listen.radioPlayback === "loading");
  const toggleSoothing = () => {
    listen.setMode("radio");
    if (soothingIsPlaying) listen.toggleRadio();
    else listen.selectStation(soothingStation);
  };
  return (
    <section className={styles.surface} role="dialog" aria-modal="true" aria-labelledby="break-title">
      <div className={styles.panel}>
        <p className={styles.eyebrow}>Break mode</p>
        <h2 id="break-title" className={styles.title}>Step away for a moment.</h2>
        <p className={styles.copy}>Your focus clock is held. Choose a small reset.</p>
        <p key={noteIndex} className={styles.note}>{BREAK_NOTES[noteIndex]}</p>

        <div className={styles.selector} role="tablist" aria-label="Break activity">
          <button type="button" role="tab" aria-selected={activity === "breathe"} onClick={() => setActivity("breathe")}>Breathe</button>
          <button type="button" role="tab" aria-selected={activity === "stretch"} onClick={() => setActivity("stretch")}>Stretch</button>
        </div>

        {activity === "breathe" ? (
          <div className={styles.breathingStage} role="status" aria-live="polite">
            <span className={styles.breathingRing} aria-hidden="true" />
            <span className={styles.breathingCore} aria-hidden="true" />
            <p className={styles.breathingInstruction}>{breathCopy}</p>
            <p className={styles.breathingCount}>Deep breath {breathNumber} of 3</p>
          </div>
        ) : (
          <div className={styles.stretchStage} role="status">
            <svg className={styles.stretchFigure} viewBox="0 0 132 180" aria-hidden="true">
              <circle className={styles.figureLine} cx="66" cy="33" r="13" />
              <path className={styles.figureLine} d="M66 47V108M66 70L41 43M66 70L91 43M66 108L48 152M66 108L84 152" />
              <g className={styles.stretchArms}><path className={styles.figureSoft} d="M41 43L27 20M91 43L105 20" /></g>
              <path className={styles.figureLine} d="M36 154H96" opacity=".52" />
            </svg>
            <p className={styles.stretchCopy}>Lift your arms. Let your shoulders soften.</p>
          </div>
        )}

        <div className={styles.soothing}>
          <p>🎧 Listen to something soothing</p>
          <span>{soothingIsPlaying ? `Chillsynth · ${listen.radioPlayback === "loading" ? "tuning" : "playing"}` : "Chillsynth · chill synth"}</span>
          <button type="button" className={styles.soothingToggle} aria-pressed={soothingIsPlaying} aria-label={soothingIsPlaying ? "Turn off Chillsynth radio" : "Play Chillsynth radio"} onClick={toggleSoothing}>
            {soothingIsPlaying ? "Turn radio off" : "Play Chillsynth"}
          </button>
        </div>

        <button className={styles.resume} type="button" onClick={onResume} disabled={isResuming}>
          {isResuming ? "Returning…" : "Resume focus"}
        </button>
        <p className={styles.remaining}>Break remaining · {formatRemaining(remaining)}</p>
      </div>
    </section>
  );
}
