"use client";

import {
  ChartNoAxesColumnIncreasing,
  Clock3,
  Columns3,
  Headphones,
  Layers3,
  Menu,
  Settings2,
  Target,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useCallback, useEffect, useRef, useState } from "react";
import "./radial-navigation-wheel.css";

type WheelItem = {
  id: string;
  label: string;
  description: string;
  icon: LucideIcon;
  onSelect: () => void;
};

type RadialNavigationWheelProps = {
  active: string;
  onDeck: () => void;
  onKanban: () => void;
  onGoals: () => void;
  onTime: () => void;
  onReview: () => void;
  onListen: () => void;
  onSettings: () => void;
};

const VIEWBOX = 500;
const CENTER = VIEWBOX / 2;
const OUTER_RADIUS = 211;
const INNER_RADIUS = 103;
const SEGMENT_ANGLE = 360 / 7;
const START_ANGLE = -90 - SEGMENT_ANGLE / 2;
const WHEEL_SPRING = { type: "spring" as const, stiffness: 360, damping: 25, mass: 0.8 };

function polar(radius: number, angle: number) {
  const radians = (angle * Math.PI) / 180;
  return { x: Math.cos(radians) * radius, y: Math.sin(radians) * radius };
}

function sectorPath(startAngle: number, endAngle: number) {
  const outerStart = polar(OUTER_RADIUS, startAngle);
  const outerEnd = polar(OUTER_RADIUS, endAngle);
  const innerEnd = polar(INNER_RADIUS, endAngle);
  const innerStart = polar(INNER_RADIUS, startAngle);
  const largeArc = endAngle - startAngle > 180 ? 1 : 0;

  return [
    `M ${CENTER + outerStart.x} ${CENTER + outerStart.y}`,
    `A ${OUTER_RADIUS} ${OUTER_RADIUS} 0 ${largeArc} 1 ${CENTER + outerEnd.x} ${CENTER + outerEnd.y}`,
    `L ${CENTER + innerEnd.x} ${CENTER + innerEnd.y}`,
    `A ${INNER_RADIUS} ${INNER_RADIUS} 0 ${largeArc} 0 ${CENTER + innerStart.x} ${CENTER + innerStart.y}`,
    "Z",
  ].join(" ");
}

function isTextTarget(target: EventTarget | null) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable);
}

/**
 * Option 5: a data-driven, equal-sector navigation wheel. Selection comes from
 * pointer angle rather than tiny hit targets, so it can be learned as muscle
 * memory and remains usable with a mouse, touch, or keyboard.
 */
export function RadialNavigationWheel({ active, onDeck, onKanban, onGoals, onTime, onReview, onListen, onSettings }: RadialNavigationWheelProps) {
  const reducedMotion = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const holdStartedAt = useRef<number | null>(null);
  const ignoreNextClick = useRef(false);
  const [open, setOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const [wheelSize, setWheelSize] = useState(460);

  // Clockwise from the upper segment: Goals, Time, Review, Listen, Settings,
  // Deck, Kanban. This preserves the spatial map described in the design.
  const items: WheelItem[] = [
    { id: "goals", label: "Goals", description: "Track your goals", icon: Target, onSelect: onGoals },
    { id: "calendar", label: "Time", description: "Manage your time", icon: Clock3, onSelect: onTime },
    { id: "review", label: "Review", description: "Review your progress", icon: ChartNoAxesColumnIncreasing, onSelect: onReview },
    { id: "listen", label: "Listen", description: "Audio & focus", icon: Headphones, onSelect: onListen },
    { id: "settings", label: "Settings", description: "Personalise Signal Deck", icon: Settings2, onSelect: onSettings },
    { id: "home", label: "Deck", description: "Your workspace", icon: Layers3, onSelect: onDeck },
    { id: "work", label: "Kanban", description: "Manage your tasks", icon: Columns3, onSelect: onKanban },
  ];

  const close = useCallback((restoreFocus = false) => {
    setOpen(false);
    setSelectedIndex(null);
    if (restoreFocus) window.setTimeout(() => triggerRef.current?.focus(), 0);
  }, []);

  const select = useCallback((index: number) => {
    const item = items[index];
    if (!item) return;
    item.onSelect();
    close();
  // Items are reconstructed from stable callbacks on every render. Selection
  // only needs the current handler at the click/release boundary.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [close, onDeck, onGoals, onKanban, onListen, onReview, onSettings, onTime]);

  const selectFromPointer = useCallback((clientX: number, clientY: number) => {
    const stage = stageRef.current;
    if (!stage) return;
    const rect = stage.getBoundingClientRect();
    const scale = VIEWBOX / Math.min(rect.width, rect.height);
    const x = (clientX - (rect.left + rect.width / 2)) * scale;
    const y = (clientY - (rect.top + rect.height / 2)) * scale;
    const distance = Math.hypot(x, y);
    if (distance < INNER_RADIUS || distance > OUTER_RADIUS + 10) {
      setSelectedIndex(null);
      return;
    }
    const angle = (Math.atan2(y, x) * 180) / Math.PI;
    const normalized = (angle - START_ANGLE + 360) % 360;
    setSelectedIndex(Math.min(items.length - 1, Math.floor(normalized / SEGMENT_ANGLE)));
  }, [items.length]);

  useEffect(() => {
    if (!open) return;
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => setWheelSize(stage.getBoundingClientRect().width);
    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [open]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key.toLowerCase() === "m" && !event.repeat) {
        event.preventDefault();
        if (!open) {
          holdStartedAt.current = performance.now();
          setOpen(true);
        }
        return;
      }
      if (!open) return;
      if (event.key === "Escape") {
        event.preventDefault();
        close(true);
        return;
      }
      if (event.key === "Enter" && selectedIndex !== null) {
        event.preventDefault();
        select(selectedIndex);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex(0);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex(3);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        setSelectedIndex((current) => current === null ? 2 : (current + 1) % items.length);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        setSelectedIndex((current) => current === null ? 5 : (current - 1 + items.length) % items.length);
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "m" || holdStartedAt.current === null) return;
      const heldFor = performance.now() - holdStartedAt.current;
      holdStartedAt.current = null;
      // A short press leaves the wheel open for click/keyboard selection.
      // Holding M makes the selected wedge a fast flick-to-navigate gesture.
      if (heldFor >= 170 && selectedIndex !== null) select(selectedIndex);
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [close, items.length, open, select, selectedIndex]);

  const selected = selectedIndex === null ? null : items[selectedIndex] ?? null;

  return (
    <>
      <motion.button
        ref={triggerRef}
        type="button"
        className="a02-wheel-trigger"
        aria-label="Open navigation wheel"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-keyshortcuts="M"
        whileTap={{ scale: 0.94 }}
        onClick={() => setOpen(true)}
      >
        <Menu size={21} strokeWidth={2} aria-hidden="true" />
        <span>Menu</span>
      </motion.button>

      <AnimatePresence>
        {open && (
          <motion.div
            className="a02-wheel-overlay"
            role="dialog"
            aria-modal="true"
            aria-label="Navigation wheel"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reducedMotion ? 0.12 : 0.2 }}
            onPointerDown={(event) => {
              if (event.target === event.currentTarget) close(true);
            }}
          >
            <motion.div
              ref={stageRef}
              className="a02-wheel-stage"
              initial={reducedMotion ? { opacity: 0, scale: 0.96 } : { opacity: 0, scale: 0.65 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reducedMotion ? { opacity: 0, scale: 0.97 } : { opacity: 0, scale: 0.7 }}
              transition={reducedMotion ? { duration: 0.14 } : WHEEL_SPRING}
              onPointerMove={(event) => selectFromPointer(event.clientX, event.clientY)}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setSelectedIndex(null);
              }}
              onPointerDown={(event) => {
                if (event.pointerType === "touch") {
                  event.currentTarget.setPointerCapture(event.pointerId);
                  selectFromPointer(event.clientX, event.clientY);
                }
              }}
              onPointerUp={(event) => {
                if (event.pointerType === "touch" && selectedIndex !== null) {
                  // A touch release is the selection gesture. Ignore the
                  // compatibility click that follows so it cannot navigate twice.
                  ignoreNextClick.current = true;
                  select(selectedIndex);
                }
              }}
              onClick={() => {
                if (ignoreNextClick.current) {
                  ignoreNextClick.current = false;
                  return;
                }
                if (selectedIndex !== null) select(selectedIndex);
              }}
            >
              <svg className="a02-wheel-svg" viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`} aria-hidden="true">
                <circle className="a02-wheel-outline" cx={CENTER} cy={CENTER} r={OUTER_RADIUS} />
                {items.map((item, index) => {
                  const start = START_ANGLE + index * SEGMENT_ANGLE;
                  const end = start + SEGMENT_ANGLE;
                  const midpoint = start + SEGMENT_ANGLE / 2;
                  const nudge = polar(selectedIndex === index ? 6 : 0, midpoint);
                  return (
                    <motion.path
                      key={item.id}
                      className={`a02-wheel-sector${selectedIndex === index ? " is-selected" : ""}${active === item.id ? " is-active" : ""}`}
                      d={sectorPath(start, end)}
                      animate={{ x: nudge.x, y: nudge.y }}
                      transition={reducedMotion ? { duration: 0.1 } : { type: "spring", stiffness: 420, damping: 28, mass: 0.7 }}
                    />
                  );
                })}
                <circle className="a02-wheel-inner" cx={CENTER} cy={CENTER} r={INNER_RADIUS} />
              </svg>

              {items.map((item, index) => {
                const midpoint = START_ANGLE + index * SEGMENT_ANGLE + SEGMENT_ANGLE / 2;
                const position = polar(155, midpoint);
                const nudge = polar(selectedIndex === index ? 8 : 0, midpoint);
                const Icon = item.icon;
                return (
                  <motion.button
                    key={item.id}
                    type="button"
                    className={`a02-wheel-node${selectedIndex === index ? " is-selected" : ""}${active === item.id ? " is-active" : ""}`}
                    style={{ left: "50%", top: "50%" }}
                    aria-label={`${item.label}: ${item.description}`}
                    aria-current={active === item.id ? "page" : undefined}
                    initial={reducedMotion ? { opacity: 0, scale: 0.9 } : { opacity: 0, scale: 0.25, x: 0, y: 0 }}
                    animate={{ opacity: 1, scale: selectedIndex === index ? 1.12 : 1, x: (position.x / VIEWBOX) * wheelSize + nudge.x, y: (position.y / VIEWBOX) * wheelSize + nudge.y }}
                    exit={reducedMotion ? { opacity: 0, scale: 0.94 } : { opacity: 0, scale: 0.25, x: 0, y: 0 }}
                    transition={reducedMotion ? { duration: 0.1 } : { ...WHEEL_SPRING, delay: index * 0.035 }}
                    transformTemplate={({ x, y, scale }) => `translate(-50%, -50%) translateX(${x ?? 0}) translateY(${y ?? 0}) scale(${scale ?? 1})`}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (ignoreNextClick.current) {
                        ignoreNextClick.current = false;
                        return;
                      }
                      select(index);
                    }}
                  >
                    <span className="a02-wheel-icon"><Icon size={24} strokeWidth={2} aria-hidden="true" /></span>
                    <span>{item.label}</span>
                  </motion.button>
                );
              })}

              <div className="a02-wheel-center" aria-live="polite">
                <span>{selected ? selected.label : "Navigation"}</span>
                <strong>{selected ? selected.description : "Press M or choose a direction"}</strong>
                <em>{selected ? "Click to open" : "M"}</em>
              </div>
            </motion.div>
            <p className="a02-wheel-hint">Move toward a section · Click to open · Esc to close</p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
