"use client";

import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ExternalLink, Pause, Play, Repeat2, Shuffle, SkipBack, SkipForward } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useSignalDeckListen } from "@/app/(marketing)/architecture-02/listen-state";
import styles from "./FocusListeningStudio.module.css";

function formatTime(totalSeconds: number) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function FocusListeningStudio() {
  const listen = useSignalDeckListen();
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const [open, setOpen] = useState(false);
  const [coarsePointer, setCoarsePointer] = useState(false);
  const closeTimer = useRef<number | null>(null);
  const isRadio = listen.mode === "radio";
  const active = isRadio ? listen.radioPlayback === "playing" : listen.musicPlaying;
  const track = listen.currentTrack;
  const station = listen.selectedStation;
  const title = isRadio ? station?.id ?? "Radio ready" : track?.title ?? "Listening studio";
  const detail = isRadio ? station?.genre ?? "11 stations / Radio" : track ? `${track.artist} / ${track.album}` : "Music + Radio";
  const hasCurrent = isRadio ? Boolean(station) : Boolean(track);

  useEffect(() => {
    const query = window.matchMedia("(pointer: coarse)");
    const update = () => setCoarsePointer(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  const cancelClose = useCallback(() => {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const openStudio = useCallback(() => { cancelClose(); setOpen(true); }, [cancelClose]);
  const closeStudioLater = useCallback(() => {
    if (coarsePointer) return;
    cancelClose();
    closeTimer.current = window.setTimeout(() => setOpen(false), 300);
  }, [cancelClose, coarsePointer]);

  useEffect(() => () => cancelClose(), [cancelClose]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const togglePlayback = () => isRadio ? listen.toggleRadio() : listen.toggleMusic();
  const previous = () => isRadio ? listen.previousStation() : listen.previousTrack();
  const next = () => isRadio ? listen.nextStation() : listen.nextTrack();
  const panelMotion = reducedMotion
    ? { initial: { opacity: 0, scale: .98 }, animate: { opacity: 1, scale: 1 }, exit: { opacity: 0, scale: .98 } }
    : { initial: { opacity: 0, scale: .92, y: 8, filter: "blur(3px)" }, animate: { opacity: 1, scale: [1.015, 1], y: [-2, 0], filter: "blur(0px)" }, exit: { opacity: 0, scale: .96, y: 5, filter: "blur(2px)" } };

  return (
    <aside className={`${styles.studio} ${open ? styles.studioOpen : ""}`} aria-label="Listening studio" onMouseEnter={openStudio} onMouseLeave={closeStudioLater}>
      <AnimatePresence>
        {open && <motion.div className={styles.panel} {...panelMotion} transition={{ type: "spring", stiffness: 330, damping: 26, mass: .8 }}>
          {hasCurrent ? <>
            <div className={styles.topline}><span>Now playing</span><span className={isRadio ? styles.live : ""}>{isRadio ? "Live signal" : active ? "Playing" : "Paused"}</span></div>
            <div className={styles.main}>
              <motion.div className={styles.art} data-artwork={track?.artwork} initial={reducedMotion ? { opacity: 0 } : { opacity: 0, scale: .92 }} animate={{ opacity: 1, scale: 1 }} transition={{ delay: .02, type: "spring", stiffness: 340, damping: 25 }}>
                {isRadio ? <span className={styles.artLive}>LIVE</span> : <span className={styles.artMark}>{track?.title.slice(0, 1).toUpperCase()}</span>}
              </motion.div>
              <div>
                <motion.p className={styles.artist} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .04 }}>{detail}</motion.p>
                <motion.h2 className={styles.title} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .07 }}>{title}</motion.h2>
                <motion.div className={styles.controls} initial={{ opacity: 0, y: 5 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: .1 }}>
                  <button className={styles.control} type="button" aria-label={isRadio ? "Previous station" : "Previous track"} onClick={previous} disabled={!hasCurrent}><SkipBack size={18} strokeWidth={2} /></button>
                  <button className={`${styles.control} ${styles.play}`} type="button" aria-label={active ? "Pause listening" : "Play listening"} onClick={togglePlayback} disabled={!hasCurrent}>{active ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}</button>
                  <button className={styles.control} type="button" aria-label={isRadio ? "Next station" : "Next track"} onClick={next} disabled={!hasCurrent}><SkipForward size={18} strokeWidth={2} /></button>
                </motion.div>
              </div>
            </div>
            <motion.div className={styles.progressArea} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: .13 }}>
              {isRadio ? <><div className={styles.progress} aria-label="Live radio signal" /><div className={styles.timeRow}><span>LIVE</span><span>{station?.signal}</span></div></> : <><input className={styles.progress} aria-label="Seek track" type="range" min={0} max={track?.duration ?? 0} value={listen.position} onChange={(event) => listen.setPosition(Number(event.target.value))} /><div className={styles.timeRow}><span>{formatTime(listen.position)}</span><span>{formatTime(track?.duration ?? 0)}</span></div></>}
              <div className={styles.utility}>
                <button className={styles.control} type="button" aria-label="Toggle shuffle" aria-pressed={listen.shuffle} onClick={() => listen.setShuffle(!listen.shuffle)}><Shuffle size={15} /></button>
                <button className={styles.control} type="button" aria-label={`Cycle repeat mode, currently ${listen.repeat}`} aria-pressed={listen.repeat !== "off"} onClick={listen.cycleRepeat}><Repeat2 size={15} /></button>
                <button className={styles.openStudio} type="button" onClick={() => router.push("/architecture-02?deck=listen")}>Open studio <ExternalLink size={12} /></button>
              </div>
            </motion.div>
          </> : <div className={styles.empty}><div><p className={styles.topline}>Nothing playing</p><h3>Start something from Listening Studio.</h3><p>Music and Radio stay available while you focus.</p><button className={styles.openStudio} type="button" onClick={() => router.push("/architecture-02?deck=listen")}>Open studio <ExternalLink size={12} /></button></div></div>}
        </motion.div>}
      </AnimatePresence>
      <button className={styles.trigger} type="button" aria-expanded={open} aria-haspopup="dialog" onFocus={openStudio} onClick={() => {
        if (coarsePointer && open) router.push("/architecture-02?deck=listen");
        else openStudio();
      }}>
        <span className={active ? `${styles.triggerWave} ${styles.triggerWaveActive}` : styles.triggerWave} aria-hidden="true">{Array.from({ length: 12 }, (_, index) => <i key={index} />)}</span>
        <span className={styles.triggerCopy}><b>{title}</b><small>{detail}</small></span>
        <span className={styles.triggerChevron} aria-hidden="true">⌃</span>
      </button>
    </aside>
  );
}
