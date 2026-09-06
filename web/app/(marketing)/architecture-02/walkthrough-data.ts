export type SignalDeckName = "home" | "work" | "calendar" | "review";

export type WalkthroughStep = {
  deck: SignalDeckName;
  description: string;
  eyebrow: string;
  id: "route" | "work" | "focus" | "review";
  preview: "route" | "work" | "focus" | "review";
  title: string;
};

// These steps intentionally describe only the shipped Signal Deck loop. They
// are not an alternate onboarding form or a promise of future product areas.
export const SIGNAL_DECK_WALKTHROUGH: WalkthroughStep[] = [
  {
    id: "route",
    deck: "home",
    eyebrow: "01 / SET THE DIRECTION",
    title: "Give the work a route.",
    description:
      "Start with one serious goal, the subjects inside it, and the days you can honestly protect. MTDO turns that into a saved route.",
    preview: "route",
  },
  {
    id: "work",
    deck: "work",
    eyebrow: "02 / FIND TODAY’S MOVE",
    title: "Keep today in motion.",
    description:
      "Work holds today’s signals in one flow: Backlog, Todo, In progress, and Done. Move a signal when its state changes; the record follows the real work.",
    preview: "work",
  },
  {
    id: "focus",
    deck: "home",
    eyebrow: "03 / ENTER FOCUS",
    title: "Make room for one thing.",
    description:
      "Open a signal and launch focus when you are ready. The Focus timer keeps one block in view so the next useful move does not get lost in the day.",
    preview: "focus",
  },
  {
    id: "review",
    deck: "review",
    eyebrow: "04 / KEEP THE PROOF",
    title: "Let the record stay honest.",
    description:
      "Review shows six weeks of settled focus and completed blocks. When there is something real to share, the Record Card turns that same record into an image.",
    preview: "review",
  },
];

export const SIGNAL_DECK_WALKTHROUGH_STORAGE_KEY = "mtdo:signal-deck:walkthrough:v1";
