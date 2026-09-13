"use client";

import { useCallback, useEffect, useState } from "react";

export const FOCUS_SANDGLASS_STORAGE_KEY = "mtdo-focus-sandglass-visible";
const FOCUS_SANDGLASS_EVENT = "mtdo-focus-sandglass-change";

function readFocusSandglassPreference() {
  try {
    return window.localStorage.getItem(FOCUS_SANDGLASS_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

function saveFocusSandglassPreference(visible: boolean) {
  try {
    window.localStorage.setItem(FOCUS_SANDGLASS_STORAGE_KEY, String(visible));
    window.dispatchEvent(new CustomEvent<boolean>(FOCUS_SANDGLASS_EVENT, { detail: visible }));
  } catch {
    // The visible in-memory state still updates if browser storage is blocked.
  }
}

/** Optional, device-level Focus visual. It does not affect session timing. */
export function useFocusSandglassPreference(): [boolean, (visible: boolean) => void] {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const update = (event?: Event) => {
      const detail = event && "detail" in event ? (event as CustomEvent<unknown>).detail : undefined;
      setVisible(typeof detail === "boolean" ? detail : readFocusSandglassPreference());
    };
    const timer = window.setTimeout(update, 0);
    window.addEventListener(FOCUS_SANDGLASS_EVENT, update);
    window.addEventListener("storage", update);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener(FOCUS_SANDGLASS_EVENT, update);
      window.removeEventListener("storage", update);
    };
  }, []);

  const choose = useCallback((next: boolean) => {
    setVisible(next);
    saveFocusSandglassPreference(next);
  }, []);

  return [visible, choose];
}
