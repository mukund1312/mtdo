"use client";

import { useEffect, useRef, useState } from "react";

import {
  SIGNAL_DECK_WALKTHROUGH,
  type SignalDeckName,
  type WalkthroughStep,
} from "./walkthrough-data";

type WalkthroughProps = {
  completionLabel?: string;
  greeting?: string | null;
  onDeckChange: (deck: SignalDeckName) => void;
  onDismiss: () => void;
  onFinish?: () => void;
  skipLabel?: string;
};

function focusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex='-1'])",
  ));
}

export function SignalDeckWalkthrough({
  completionLabel = "Explore the deck ↗",
  greeting,
  onDeckChange,
  onDismiss,
  onFinish,
  skipLabel = "Skip guide",
}: WalkthroughProps) {
  const [stepIndex, setStepIndex] = useState(0);
  const dialogRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const step = SIGNAL_DECK_WALKTHROUGH[stepIndex]!;
  const isLastStep = stepIndex === SIGNAL_DECK_WALKTHROUGH.length - 1;

  useEffect(() => {
    onDeckChange(step.deck);
  }, [onDeckChange, step.deck]);

  useEffect(() => {
    closeRef.current?.focus();
  }, []);

  const previous = () => setStepIndex((current) => Math.max(0, current - 1));
  const next = () => {
    if (isLastStep) {
      // The guide finishes on Review, but “Explore the deck” should leave a
      // new user at Signal Deck's actual home rather than its final tour step.
      onDeckChange("home");
      if (onFinish) onFinish();
      else onDismiss();
      return;
    }
    setStepIndex((current) => Math.min(SIGNAL_DECK_WALKTHROUGH.length - 1, current + 1));
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      onDismiss();
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      previous();
      return;
    }
    if (event.key === "ArrowRight") {
      event.preventDefault();
      next();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;

    const elements = focusableElements(dialogRef.current);
    if (elements.length === 0) return;
    const first = elements[0]!;
    const last = elements.at(-1)!;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <section
      className="a02-tour-overlay"
      role="dialog"
      aria-modal="true"
      aria-labelledby="a02-tour-title"
      aria-describedby="a02-tour-description"
      onKeyDown={handleKeyDown}
      ref={dialogRef}
    >
      <div className="a02-tour-dialog">
        <header className="a02-tour-header">
          <span>MTDO / SIGNAL DECK / FIELD GUIDE</span>
          <button ref={closeRef} type="button" onClick={onDismiss} aria-label="Close walkthrough">
            CLOSE <i>×</i>
          </button>
        </header>

        <div className="a02-tour-body">
          <WalkthroughPreview key={step.id} step={step} />
          <section className="a02-tour-copy" aria-live="polite">
            <span className="a02-eyebrow">{step.eyebrow}</span>
            {greeting && stepIndex === 0 && <p className="a02-tour-greeting">Hey {greeting}, let’s get you set up.</p>}
            <h2 id="a02-tour-title">{step.title}</h2>
            <p id="a02-tour-description">{step.description}</p>
            <p className="a02-tour-keyboard" aria-label="Keyboard shortcuts">
              <kbd>←</kbd><kbd>→</kbd> move <span>·</span> <kbd>esc</kbd> close
            </p>
          </section>
        </div>

        <footer className="a02-tour-footer">
          <button type="button" className="a02-tour-skip" onClick={onDismiss}>{skipLabel}</button>
          <div className="a02-tour-progress" aria-label={`Step ${stepIndex + 1} of ${SIGNAL_DECK_WALKTHROUGH.length}`}>
            <span>{String(stepIndex + 1).padStart(2, "0")} / {String(SIGNAL_DECK_WALKTHROUGH.length).padStart(2, "0")}</span>
            <div aria-hidden="true">{SIGNAL_DECK_WALKTHROUGH.map((item, index) => <i key={item.id} className={index <= stepIndex ? "is-active" : ""} />)}</div>
          </div>
          <div className="a02-tour-actions">
            <button type="button" className="a02-tour-back" onClick={previous} disabled={stepIndex === 0}>← Back</button>
            <button type="button" className="a02-tour-next" onClick={next}>{isLastStep ? completionLabel : "Next →"}</button>
          </div>
        </footer>
      </div>
    </section>
  );
}

function WalkthroughPreview({ step }: { step: WalkthroughStep }) {
  return <section className={`a02-tour-preview a02-tour-preview--${step.preview}`} aria-hidden="true">
    <span className="a02-tour-preview-index">0{SIGNAL_DECK_WALKTHROUGH.findIndex((item) => item.id === step.id) + 1}</span>
    {step.preview === "route" && <div className="a02-tour-route-preview"><i className="a02-tour-orbit a02-tour-orbit--one" /><i className="a02-tour-orbit a02-tour-orbit--two" /><b>◒</b><div><span>GOAL ROUTE</span><strong>direction<br /><em>made clear.</em></strong><small>GOAL → RHYTHM → ROUTE</small></div></div>}
    {step.preview === "work" && <div className="a02-tour-work-preview">{["BACKLOG", "TODO", "IN PROGRESS", "DONE"].map((lane, index) => <div key={lane}><span>0{index + 1} / {lane}</span><i /><i /><b /></div>)}</div>}
    {step.preview === "focus" && <div className="a02-tour-focus-preview"><span>ONE SIGNAL / READY</span><div><i /><b>FOCUS</b><strong>45:00</strong><small>ONE BLOCK IN VIEW</small></div><em>BEGIN WHEN READY</em></div>}
    {step.preview === "review" && <div className="a02-tour-review-preview"><header><span>REVIEW / UTC RECORD</span><b>6 WEEKS</b></header><div>{Array.from({ length: 42 }, (_, index) => <i key={index} className={index % 9 === 0 || index % 13 === 0 ? "is-lit" : ""} />)}</div><footer><span>SETTLED SESSIONS</span><b>RECORD CARD ↗</b></footer></div>}
  </section>;
}
