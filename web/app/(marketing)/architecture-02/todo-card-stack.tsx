"use client";

// Reusable iMessage-style stacked-card shuffle, generic over card content.
// Not specific to the Signal Deck -- takes any array of items and a render
// function, so this same component could stack anything else later.
//
// Math is the caller's spec, verbatim:
//   scale factor  = 1 - (index * 0.05)
//   Y-offset      = -(index * 12px)
//   dismiss when drag exceeds 150px on X
//   spring back otherwise (damping ratio 0.7, response 0.4s in SwiftUI's
//   terms -- Framer Motion's spring is parameterized differently
//   (stiffness/damping/mass, not damping-ratio/response), so this uses the
//   standard conversion for a critically-near spring at that response time:
//   angular frequency = 2*pi/response, stiffness = mass * frequency^2,
//   damping = 2 * dampingRatio * mass * frequency. mass=1 throughout.)
//
// Dismissal here is non-destructive: dismissing a card advances the stack
// to the next item and moves the dismissed one to the back (a true shuffle
// -- "see all the todos" -- not an iMessage-style permanent delete). Only
// the caller's own action on a card's content (e.g. "Start Focus") is
// meant to act on the underlying item; dragging never does.

import { PanInfo, motion, useAnimation } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";

const SCALE_STEP = 0.05;
const Y_OFFSET_STEP = 12;
const DISMISS_THRESHOLD_X = 150;
const VISIBLE_DEPTH = 3; // cards rendered behind the top one -- deeper ones add nothing visible past this and cost paint for free

const RESPONSE_S = 0.4;
const DAMPING_RATIO = 0.7;
const ANGULAR_FREQUENCY = (2 * Math.PI) / RESPONSE_S;
const SPRING = {
  type: "spring" as const,
  stiffness: ANGULAR_FREQUENCY ** 2,
  damping: 2 * DAMPING_RATIO * ANGULAR_FREQUENCY,
  mass: 1,
};

export interface CardStackProps<T> {
  items: T[];
  getKey: (item: T) => string;
  renderCard: (item: T, isTop: boolean) => React.ReactNode;
  /** Fires whenever the top card changes -- including the initial mount --
   * so a caller that needs to act on "whichever card is on top right now"
   * (e.g. a Start Focus button outside the stack) doesn't have to guess. */
  onTopChange?: (item: T) => void;
  /** A plain tap on the top card (not a drag). Suppressing the click that
   * a drag-release also fires is done explicitly here (an onDragStart
   * flag, checked and reset in the click handler) rather than relying on
   * Framer Motion's own tap/drag disambiguation -- that turned out not to
   * reliably suppress the click in practice, so don't reintroduce a
   * dependency on it. */
  onCardClick?: (item: T) => void;
  className?: string;
}

export function CardStack<T>({ items, getKey, renderCard, onTopChange, onCardClick, className }: CardStackProps<T>) {
  // Order is caller data order; `offset` rotates which item is "on top"
  // without mutating the caller's array -- a card that's dismissed moves
  // conceptually to the back by advancing the offset, nothing is removed.
  const [offset, setOffset] = useState(0);
  const controls = useAnimation();
  const didDrag = useRef(false);

  const ordered = items.length > 0 ? items.map((_, i) => items[(i + offset) % items.length]!) : [];
  const topItem = ordered[0];

  useEffect(() => {
    if (topItem) onTopChange?.(topItem);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by identity below, not the whole item/callback, so this only fires on a genuine top-card change
  }, [topItem ? getKey(topItem) : null]);

  const advance = useCallback(() => {
    setOffset((current) => (items.length > 0 ? (current + 1) % items.length : current));
  }, [items.length]);

  const handleClick = useCallback(
    (item: T) => {
      if (didDrag.current) {
        didDrag.current = false;
        return;
      }
      onCardClick?.(item);
    },
    [onCardClick],
  );

  const handleDragEnd = useCallback(
    async (_event: unknown, info: PanInfo) => {
      if (Math.abs(info.offset.x) > DISMISS_THRESHOLD_X) {
        const direction = info.offset.x > 0 ? 1 : -1;
        await controls.start({
          x: direction * 500,
          opacity: 0,
          transition: { duration: 0.22, ease: "easeIn" },
        });
        controls.set({ x: 0, opacity: 1 });
        advance();
      } else {
        void controls.start({ x: 0, y: 0, transition: SPRING });
      }
    },
    [controls, advance],
  );

  if (ordered.length === 0) return null;

  return (
    <div className={`a02-card-stack ${className ?? ""}`}>
      {ordered
        .slice(0, VISIBLE_DEPTH)
        .map((item, index) => {
          const isTop = index === 0;
          const scale = 1 - index * SCALE_STEP;
          const y = -(index * Y_OFFSET_STEP);
          return (
            <motion.div
              key={getKey(item)}
              className="a02-card-stack-item"
              style={{ zIndex: VISIBLE_DEPTH - index }}
              animate={isTop ? controls : { scale, y, opacity: 1 }}
              initial={{ scale, y, opacity: 1 }}
              transition={SPRING}
              drag={isTop ? "x" : false}
              dragElastic={0.5}
              dragConstraints={{ left: 0, right: 0 }}
              onDragStart={isTop ? () => { didDrag.current = true; } : undefined}
              onDragEnd={isTop ? handleDragEnd : undefined}
              onClick={isTop ? () => handleClick(item) : undefined}
              whileDrag={{ cursor: "grabbing" }}
            >
              {renderCard(item, isTop)}
            </motion.div>
          );
        })}
    </div>
  );
}
