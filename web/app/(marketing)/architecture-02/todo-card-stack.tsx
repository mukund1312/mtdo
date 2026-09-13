"use client";

// A non-destructive Focus/task deck. The caller's data is never reordered;
// `offset` only changes which item is visually on top. Scrolling while the
// pointer is over this surface advances one intentional card at a time.

import { motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

const SCALE_STEP = 0.05;
const Y_OFFSET_STEP = 12;
const X_OFFSET_STEP = 4;
const VISIBLE_DEPTH = 3;
const WHEEL_THRESHOLD = 28;
const SHUFFLE_LOCK_MS = 340;
const EXIT_DURATION_MS = 430;
const SPRING = { type: "spring" as const, stiffness: 360, damping: 24, mass: 0.78 };

export interface CardStackProps<T> {
  items: T[];
  getKey: (item: T) => string;
  renderCard: (item: T, isTop: boolean) => React.ReactNode;
  onTopChange?: (item: T) => void;
  onCardClick?: (item: T) => void;
  className?: string;
}

type DepartingCard<T> = { item: T; direction: 1 | -1; velocity: number };

export function CardStack<T>({ items, getKey, renderCard, onTopChange, onCardClick, className }: CardStackProps<T>) {
  const [offset, setOffset] = useState(0);
  const [departing, setDeparting] = useState<DepartingCard<T> | null>(null);
  const reducedMotion = useReducedMotion();
  const wheelDelta = useRef(0);
  const wheelLocked = useRef(false);
  const unlockTimer = useRef<number | null>(null);
  const departureTimer = useRef<number | null>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const cycleRef = useRef<(direction: 1 | -1, velocity?: number) => void>(() => undefined);
  const itemCountRef = useRef(items.length);
  const topItemRef = useRef<T | undefined>(undefined);

  const ordered = items.length > 0 ? items.map((_, index) => items[(index + offset) % items.length]!) : [];
  const topItem = ordered[0];

  useEffect(() => {
    if (topItem) onTopChange?.(topItem);
    // Fires only when the visible card identity changes, not on every card
    // transform during a shuffle.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topItem ? getKey(topItem) : null]);

  useEffect(() => {
    topItemRef.current = topItem;
  }, [topItem]);

  useEffect(() => () => {
    if (unlockTimer.current !== null) window.clearTimeout(unlockTimer.current);
    if (departureTimer.current !== null) window.clearTimeout(departureTimer.current);
  }, []);

  const cycle = useCallback((direction: 1 | -1, velocity = 0) => {
    const currentTop = topItemRef.current;
    if (!currentTop || items.length < 2 || wheelLocked.current) return;
    wheelLocked.current = true;
    setDeparting({ item: currentTop, direction, velocity: Math.min(1, Math.abs(velocity) / 180) });
    setOffset((current) => (current + direction + items.length) % items.length);
    wheelDelta.current = 0;
    if (unlockTimer.current !== null) window.clearTimeout(unlockTimer.current);
    if (departureTimer.current !== null) window.clearTimeout(departureTimer.current);
    unlockTimer.current = window.setTimeout(() => {
      wheelLocked.current = false;
      // Momentum collected during the first shuffle becomes the next
      // deliberate card step instead of getting lost. One fast wheel flick
      // can move through the deck, but never skips a visible transition.
      if (Math.abs(wheelDelta.current) >= WHEEL_THRESHOLD) {
        cycleRef.current(wheelDelta.current > 0 ? 1 : -1, wheelDelta.current);
      }
    }, reducedMotion ? 90 : SHUFFLE_LOCK_MS);
    departureTimer.current = window.setTimeout(() => setDeparting(null), reducedMotion ? 110 : EXIT_DURATION_MS);
  }, [items.length, reducedMotion]);
  useEffect(() => {
    itemCountRef.current = items.length;
    cycleRef.current = cycle;
  }, [cycle, items.length]);

  // React may register wheel delegation as passive in some browser/runtime
  // combinations. This native, explicitly non-passive listener guarantees
  // that page scrolling is held only while this deck owns the wheel gesture.
  useEffect(() => {
    const stack = stackRef.current;
    if (!stack) return;
    const handleWheel = (event: globalThis.WheelEvent) => {
      if (itemCountRef.current < 2) return;
      event.preventDefault();
      wheelDelta.current += event.deltaY;
      if (wheelLocked.current || Math.abs(wheelDelta.current) < WHEEL_THRESHOLD) return;
      cycleRef.current(wheelDelta.current > 0 ? 1 : -1, event.deltaY);
    };
    stack.addEventListener("wheel", handleWheel, { passive: false });
    return () => stack.removeEventListener("wheel", handleWheel);
  }, []);

  if (ordered.length === 0) return null;

  return (
    <div
      className={`a02-card-stack ${className ?? ""}`}
      ref={stackRef}
      role="region"
      aria-label="Focus task deck"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); cycle(1); }
        if (event.key === "ArrowUp") { event.preventDefault(); cycle(-1); }
      }}
    >
      {ordered.slice(0, VISIBLE_DEPTH).map((item, index) => {
        const isTop = index === 0;
        return (
          <motion.div
            key={getKey(item)}
            className="a02-card-stack-item"
            style={{ zIndex: VISIBLE_DEPTH - index }}
            initial={false}
            animate={{
              x: index * X_OFFSET_STEP,
              y: -(index * Y_OFFSET_STEP),
              scale: 1 - index * SCALE_STEP,
              z: 18 - index * 12,
              rotateX: index * 1.1,
              rotate: index * 0.38,
              opacity: 1 - index * 0.12,
            }}
            transition={reducedMotion ? { duration: 0.14 } : SPRING}
            onClick={isTop ? () => onCardClick?.(item) : undefined}
          >
            {renderCard(item, isTop)}
          </motion.div>
        );
      })}
      {departing && (
        <motion.div
          key={`departing-${getKey(departing.item)}`}
          className="a02-card-stack-item a02-card-stack-departing"
          style={{ zIndex: VISIBLE_DEPTH + 1 }}
          initial={{ x: 0, y: 0, z: 18, scale: 1, rotateX: 0, rotate: 0, opacity: 1 }}
          animate={reducedMotion
            ? { opacity: 0, scale: 0.98 }
            : {
                // Lift towards the user first, then settle into the deck's
                // rear plane. This makes the rotation feel like a shuffle,
                // rather than a card simply fading out of a carousel.
                x: [0, departing.direction * (16 + departing.velocity * 14), departing.direction * X_OFFSET_STEP * VISIBLE_DEPTH],
                y: [0, -42 - departing.velocity * 16, -(VISIBLE_DEPTH + 0.5) * Y_OFFSET_STEP],
                z: [18, 34, -20],
                scale: [1, 1.025, 0.82],
                rotateX: [0, -2, 2.4],
                rotate: [0, departing.direction * (2.4 + departing.velocity), departing.direction * 1.1],
                opacity: [1, 1, 0.34],
              }}
          transition={reducedMotion
            ? { duration: 0.12 }
            : { duration: EXIT_DURATION_MS / 1000, times: [0, 0.42, 1], ease: ["easeOut", [0.22, 0.85, 0.32, 1]] }}
        >
          {renderCard(departing.item, false)}
        </motion.div>
      )}
    </div>
  );
}
