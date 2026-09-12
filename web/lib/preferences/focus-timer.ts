"use client";

import { useCallback, useEffect, useState } from "react";

export const FOCUS_TIMER_STORAGE_KEY = "mtdo-focus-timer-visible";
const FOCUS_TIMER_EVENT = "mtdo-focus-timer-change";

function readFocusTimerPreference() {
  try {
    return window.localStorage.getItem(FOCUS_TIMER_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function saveFocusTimerPreference(visible: boolean) {
  try {
    window.localStorage.setItem(FOCUS_TIMER_STORAGE_KEY, String(visible));
    window.dispatchEvent(new CustomEvent<boolean>(FOCUS_TIMER_EVENT, { detail: visible }));
  } catch {
    // The calling component still updates its in-memory state.
  }
}

/** Device-level Focus preference shared by the active session on this device. */
export function useFocusTimerPreference(): [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const update = (event?: Event) => {
      const detail = event && "detail" in event ? (event as CustomEvent<unknown>).detail : undefined;
      setVisible(typeof detail === "boolean" ? detail : readFocusTimerPreference());
    };
    const timer = window.setTimeout(update, 0);
    window.addEventListener(FOCUS_TIMER_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(FOCUS_TIMER_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  const choose = useCallback((next: boolean) => {
    setVisible(next);
    saveFocusTimerPreference(next);
  }, []);

  return [visible, choose];
}
