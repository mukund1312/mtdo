"use client";

import {
  BarChart3,
  Clock3,
  Headphones,
  Layers3,
  LayoutPanelTop,
  Menu,
  Settings2,
  Target,
  type LucideIcon,
} from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import "./radial-menu.css";

type RadialMenuItem = {
  id: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
};

type RadialMenuProps = {
  active: string;
  variant?: "fan" | "orbit" | "rail" | "inline";
  onDeck: () => void;
  onKanban: () => void;
  onGoals: () => void;
  onTime: () => void;
  onReview: () => void;
  onListen: () => void;
  onSettings: () => void;
};

const SPRING = { type: "spring" as const, stiffness: 300, damping: 22, mass: 0.8 };
const OPEN_ARC_START = -165;
const OPEN_ARC_END = -15;
const DESKTOP_RADIUS = 192;
const MOBILE_RADIUS = 142;
const ORBIT_RADII = [190, 158, 206, 232, 206, 158, 190];

function pointForNavigation(
  index: number,
  total: number,
  radius: number,
  variant: "fan" | "orbit" | "rail" | "inline",
  isCompact: boolean,
  isNarrow: boolean,
) {
  if (variant === "inline") {
    const spacing = isCompact ? 42 : isNarrow ? 73 : 100;
    // Deck · Kanban · Goals | MENU | Time · Review · Listen · Settings
    const slot = index < 3 ? index - 3 : index - 2;
    return { x: slot * spacing, y: 0 };
  }
  if (variant === "rail") {
    const spacing = isCompact ? 48 : 86;
    return { x: (index - (total - 1) / 2) * spacing, y: isCompact ? -66 : -86 };
  }
  const angle = OPEN_ARC_START + ((OPEN_ARC_END - OPEN_ARC_START) * index) / (total - 1);
  const radians = (angle * Math.PI) / 180;
  const orbitRadius = variant === "orbit" ? (ORBIT_RADII[index] ?? radius) * (radius / DESKTOP_RADIUS) : radius;
  return { x: Math.cos(radians) * orbitRadius, y: Math.sin(radians) * orbitRadius };
}

/**
 * One origin orb for every Signal Deck destination. The items stay data-driven
 * and their x/y coordinates are calculated from equal arc angles, rather than
 * being individually positioned in markup.
 */
export function RadialMenu({ active, variant = "fan", onDeck, onKanban, onGoals, onTime, onReview, onListen, onSettings }: RadialMenuProps) {
  const reducedMotion = useReducedMotion();
  const rootRef = useRef<HTMLElement>(null);
  const closeTimer = useRef<number | null>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [open, setOpen] = useState(false);
  const [pinnedOpen, setPinnedOpen] = useState(false);
  const [isCompact, setIsCompact] = useState(false);
  const [isNarrow, setIsNarrow] = useState(false);

  const items: RadialMenuItem[] = [
    { id: "home", label: "Deck", icon: Layers3, onSelect: onDeck },
    { id: "work", label: "Kanban", icon: LayoutPanelTop, onSelect: onKanban },
    { id: "goals", label: "Goals", icon: Target, onSelect: onGoals },
    { id: "calendar", label: "Time", icon: Clock3, onSelect: onTime },
    { id: "review", label: "Review", icon: BarChart3, onSelect: onReview },
    { id: "listen", label: "Listen", icon: Headphones, onSelect: onListen },
    { id: "settings", label: "Settings", icon: Settings2, onSelect: onSettings },
  ];

  const clearCloseTimer = () => {
    if (closeTimer.current !== null) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };

  const openMenu = () => {
    clearCloseTimer();
    setOpen(true);
  };

  const closeMenu = (restoreFocus = false) => {
    clearCloseTimer();
    setPinnedOpen(false);
    setOpen(false);
    if (restoreFocus) window.setTimeout(() => menuButtonRef.current?.focus(), 0);
  };

  const scheduleClose = () => {
    if (pinnedOpen) return;
    clearCloseTimer();
    closeTimer.current = window.setTimeout(() => setOpen(false), 190);
  };

  useEffect(() => {
    const compact = window.matchMedia("(max-width: 560px)");
    const update = () => setIsCompact(compact.matches);
    update();
    compact.addEventListener("change", update);
    return () => compact.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 960px)");
    const update = () => setIsNarrow(narrow.matches);
    update();
    narrow.addEventListener("change", update);
    return () => narrow.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
        if (event.key === "Escape") {
          event.preventDefault();
          setPinnedOpen(false);
          setOpen(false);
        window.setTimeout(() => menuButtonRef.current?.focus(), 0);
      }
    };
    const onPointerDown = (event: PointerEvent) => {
      if (isCompact && rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setPinnedOpen(false);
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("pointerdown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("pointerdown", onPointerDown);
    };
  }, [isCompact, open]);

  useEffect(() => () => clearCloseTimer(), []);

  const radius = isCompact ? MOBILE_RADIUS : DESKTOP_RADIUS;

  const moveFocus = (from: number, direction: 1 | -1) => {
    const next = (from + direction + items.length) % items.length;
    itemRefs.current[next]?.focus();
  };

  return (
    <nav
      ref={rootRef}
      className={`a02-radial-menu a02-radial-menu--${variant}${open ? " is-open" : ""}`}
      aria-label="Signal deck navigation"
      onPointerEnter={(event) => {
        if (!isCompact && (event.pointerType === "mouse" || event.pointerType === "pen")) openMenu();
      }}
      onPointerLeave={(event) => {
        if (!isCompact && (event.pointerType === "mouse" || event.pointerType === "pen")) scheduleClose();
      }}
    >
      <AnimatePresence>
        {open && (
          <>
            {!reducedMotion && variant !== "rail" && variant !== "inline" && <div className="a02-radial-menu-rings" aria-hidden="true"><i /><i /><i /></div>}
            {items.map((item, index) => {
              const position = pointForNavigation(index, items.length, radius, variant, isCompact, isNarrow);
              const Icon = item.icon;
              const isActive = active === item.id;
              return (
                <motion.button
                  key={item.id}
                  type="button"
                  className={`a02-radial-menu-item${isActive ? " is-active" : ""}`}
                  aria-current={isActive ? "page" : undefined}
                  aria-label={item.label}
                  initial={reducedMotion ? { opacity: 0, scale: 0.86 } : { opacity: 0, scale: 0.32, x: 0, y: 0 }}
                  animate={reducedMotion ? { opacity: 1, scale: 1 } : { opacity: 1, scale: 1, x: position.x, y: position.y }}
                  exit={reducedMotion ? { opacity: 0, scale: 0.92 } : { opacity: 0, scale: 0.35, x: 0, y: 0 }}
                  transition={reducedMotion ? { duration: 0.16, delay: index * 0.02 } : { ...SPRING, stiffness: variant === "orbit" ? 270 : variant === "rail" ? 320 : variant === "inline" ? 330 : 300, damping: variant === "orbit" ? 19 : variant === "rail" ? 24 : variant === "inline" ? 25 : 22, delay: index * (variant === "orbit" ? 0.045 : variant === "rail" || variant === "inline" ? 0.03 : 0.035) }}
                  whileHover={reducedMotion ? undefined : { scale: 1.07, transition: { duration: 0.16 } }}
                  whileTap={{ scale: 0.94, transition: { duration: 0.1 } }}
                  ref={(element) => { itemRefs.current[index] = element; }}
                  onFocus={openMenu}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
                      event.preventDefault();
                      moveFocus(index, 1);
                    }
                    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
                      event.preventDefault();
                      moveFocus(index, -1);
                    }
                  }}
                  onClick={() => {
                    item.onSelect();
                    closeMenu();
                  }}
                >
                  <span className="a02-radial-menu-icon"><Icon size={24} strokeWidth={2} aria-hidden="true" /></span>
                  <span className="a02-radial-menu-label">{item.label}</span>
                </motion.button>
              );
            })}
          </>
        )}
      </AnimatePresence>

      <motion.button
        ref={menuButtonRef}
        type="button"
        className="a02-radial-menu-trigger"
        aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open}
        aria-haspopup="menu"
        whileTap={{ scale: 0.92 }}
        animate={open && !reducedMotion ? { scale: [1, 0.92, 1] } : { scale: 1 }}
        transition={reducedMotion ? { duration: 0.12 } : { duration: 0.28, times: [0, 0.35, 1] }}
        onFocus={openMenu}
        onPointerEnter={(event) => {
          if (!isCompact && (event.pointerType === "mouse" || event.pointerType === "pen")) openMenu();
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowUp" || event.key === "ArrowLeft" || event.key === "ArrowRight" || event.key === "ArrowDown") {
            event.preventDefault();
            openMenu();
            window.setTimeout(() => itemRefs.current[0]?.focus(), 0);
          }
        }}
        onClick={() => {
          if (open && pinnedOpen) {
            closeMenu();
            return;
          }
          clearCloseTimer();
          setPinnedOpen(true);
          setOpen(true);
        }}
      >
        <Menu size={22} strokeWidth={2} aria-hidden="true" />
        <span>Menu</span>
      </motion.button>
    </nav>
  );
}
