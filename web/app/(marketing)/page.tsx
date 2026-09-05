"use client";

import { useEffect, useState } from "react";

const modes = ["Route", "Focus", "Proof"] as const;
type Mode = (typeof modes)[number];

const modeContent: Record<Mode, { eyebrow: string; title: string; body: string }> = {
  Route: {
    eyebrow: "01 · the route",
    title: "The next step earns its place.",
    body: "A goal becomes a sequence of decisions, kept deliberately small enough to begin.",
  },
  Focus: {
    eyebrow: "02 · the hour",
    title: "A room for the work at hand.",
    body: "The timer gives time a clear boundary. Supporting context stays quiet at the edge.",
  },
  Proof: {
    eyebrow: "03 · the record",
    title: "The evidence stays honest.",
    body: "A record of time and returns, without scores, trophies, or invented momentum.",
  },
};

const heatmap = [0, 1, 0, 2, 0, 3, 1, 0, 1, 2, 3, 0, 2, 4, 3, 0, 1, 2, 0, 3, 4, 2, 1, 3, 0, 2, 4, 1] as const;
const heatColors = ["rgba(255,255,255,.06)", "#0E7490", "#0891B2", "#06B6D4", "#22D3EE"] as const;

function Mark() {
  return <span aria-hidden="true" className="grid h-6 w-6 place-items-center rounded-full border border-[var(--border)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--accent)]" /></span>;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[11px] font-normal uppercase tracking-[0.15em] text-[var(--accent)]">{children}</p>;
}

export default function MarketingHomePage() {
  const [activeMode, setActiveMode] = useState<Mode>("Focus");
  const [isScrolled, setIsScrolled] = useState(false);
  const [isPaletteOpen, setIsPaletteOpen] = useState(false);

  useEffect(() => {
    const updateNav = () => setIsScrolled(window.scrollY > 24);
    updateNav();
    window.addEventListener("scroll", updateNav, { passive: true });
    return () => window.removeEventListener("scroll", updateNav);
  }, []);

  const content = modeContent[activeMode];

  return (
    <main className="min-h-dvh overflow-hidden bg-[var(--bg)] text-[var(--text)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[760px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(34,211,238,.09),transparent_70%)]" />

      <nav
        aria-label="Primary navigation"
        className={`fixed left-1/2 top-5 z-30 flex min-h-11 w-[calc(100%-32px)] max-w-[860px] -translate-x-1/2 items-center justify-between rounded-full border px-3 py-2 transition-all duration-300 ${isScrolled ? "border-[var(--border)] bg-[rgba(11,11,12,.82)] shadow-[0_10px_40px_rgba(0,0,0,.6)] backdrop-blur-xl" : "border-transparent bg-transparent"}`}
      >
        <a href="#arrival" className="flex min-h-11 items-center gap-2 rounded-full px-3 text-[15px] font-bold tracking-[-0.025em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">
          <Mark /> mtdo
        </a>
        <div className="hidden items-center gap-1 md:flex">
          {[["Experience", "#experience"], ["Language", "#language"], ["About", "#closing"]].map(([label, href]) => (
            <a key={href} href={href} className="flex min-h-11 items-center rounded-full px-4 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">{label}</a>
          ))}
        </div>
        <button type="button" onClick={() => setIsPaletteOpen(true)} className="flex min-h-11 items-center rounded-full border border-[var(--border)] px-4 text-[13px] font-medium text-[var(--text)] transition-all duration-200 hover:border-[rgba(34,211,238,.45)] hover:bg-[var(--surface)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">Explore concept <span className="ml-2 text-[var(--dim)]">↗</span></button>
      </nav>

      <section id="arrival" className="relative mx-auto flex min-h-[820px] max-w-[1280px] flex-col justify-end px-[30px] pb-16 pt-[180px] sm:pb-24 lg:pb-28">
        <div className="grid gap-12 lg:grid-cols-[1.16fr_.84fr] lg:items-end">
          <div className="relative z-10 max-w-[820px]">
            <Eyebrow>A visual concept for deliberate progress</Eyebrow>
            <h1 className="m-0 mt-7 text-[clamp(54px,8.2vw,118px)] font-black leading-[.88] tracking-[-0.06em]">Give the<br />important thing<br /><span className="text-[var(--muted)]">a shape.</span></h1>
            <p className="mb-0 mt-9 max-w-[510px] text-[17px] font-light leading-7 text-[var(--muted)]">MTDO is a quieter way to get somewhere: a route, an hour of focus, and proof you can trust.</p>
            <div className="mt-10 flex flex-wrap gap-3">
              <a href="#experience" className="flex min-h-12 items-center rounded-full bg-[var(--accent)] px-6 text-[13px] font-medium text-[#061113] transition-transform duration-200 ease-[var(--ease-spring)] hover:scale-[1.045] active:scale-[.98] focus-visible:ring-2 focus-visible:ring-white">Enter the experience</a>
              <a href="#language" className="flex min-h-12 items-center rounded-full px-5 text-[13px] text-[var(--muted)] transition-colors hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">Design language <span className="ml-2">↓</span></a>
            </div>
          </div>

          <div className="relative mx-auto w-full max-w-[440px] self-end lg:translate-y-5">
            <div className="mtdo-drift relative overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[#101214] p-5 sm:p-7">
              <div className="absolute -right-10 -top-10 h-44 w-44 rounded-full bg-[rgba(34,211,238,.07)] blur-3xl" />
              <div className="relative flex items-center justify-between text-[11px] uppercase tracking-[0.14em] text-[var(--dim)]"><span>Today / 09.05</span><span className="num">01 — 03</span></div>
              <div className="relative mt-16">
                <p className="m-0 text-[11px] uppercase tracking-[0.14em] text-[var(--accent)]">The next useful thing</p>
                <h2 className="mb-0 mt-4 max-w-[310px] text-[29px] font-bold leading-[1.03] tracking-[-0.04em]">Find the idea you can explain in one breath.</h2>
                <p className="mb-0 mt-5 max-w-[290px] font-light leading-6 text-[var(--muted)]">A small task made visible at the moment it matters.</p>
              </div>
              <div className="relative mt-16"><div className="mb-3 flex items-center justify-between text-[11px] text-[var(--dim)]"><span>Route progress</span><span className="num">38%</span></div><div className="h-px bg-white/[.1]"><div className="h-px w-[38%] bg-[var(--accent)]" /></div></div>
            </div>
            <p className="mt-5 text-right text-[11px] uppercase tracking-[0.14em] text-[var(--dim)]">A single clear instruction</p>
          </div>
        </div>
      </section>

      <section className="border-y border-[var(--border)] bg-white/[.012]">
        <div className="mx-auto grid max-w-[1280px] gap-8 px-[30px] py-10 md:grid-cols-[.7fr_1fr_1fr] md:items-center">
          <p className="m-0 text-[13px] font-light leading-6 text-[var(--muted)]">Built for students and self-directed learners who prefer a real record to a loud reward.</p>
          <p className="m-0 border-l border-[var(--border)] pl-6 text-[13px] font-light leading-6 text-[var(--muted)]">The route creates direction. The hour creates attention. The record creates trust.</p>
          <p className="m-0 border-l border-[var(--border)] pl-6 text-[13px] font-light leading-6 text-[var(--muted)]">No inflated streaks. No virtual trophies. No pressure to perform for a feed.</p>
        </div>
      </section>

      <section id="experience" className="relative mx-auto max-w-[1280px] px-[30px] py-24 md:py-[160px]">
        <div className="max-w-[670px]"><Eyebrow>The essential loop</Eyebrow><h2 className="mb-0 mt-6 text-[clamp(38px,5vw,70px)] font-bold leading-[.95] tracking-[-0.055em]">Less interface.<br />More intention.</h2></div>
        <div className="mt-16 grid min-h-[670px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[#101214] lg:grid-cols-[.76fr_1.24fr]">
          <aside className="flex flex-col justify-between border-b border-[var(--border)] p-7 sm:p-10 lg:border-b-0 lg:border-r">
            <div>
              <div className="flex gap-2" role="tablist" aria-label="Concept states">
                {modes.map((mode) => <button key={mode} type="button" role="tab" aria-selected={activeMode === mode} onClick={() => setActiveMode(mode)} className={`min-h-10 rounded-full px-3 text-[12px] transition-all ${activeMode === mode ? "bg-[var(--text)] text-[var(--bg)]" : "text-[var(--dim)] hover:text-[var(--text)]"}`}>{mode}</button>)}
              </div>
              <p className="mb-0 mt-14 text-[11px] uppercase tracking-[0.14em] text-[var(--accent)]">{content.eyebrow}</p>
              <h3 className="mb-0 mt-5 max-w-[380px] text-[34px] font-bold leading-[1.02] tracking-[-0.045em]">{content.title}</h3>
              <p className="mb-0 mt-5 max-w-[350px] font-light leading-7 text-[var(--muted)]">{content.body}</p>
            </div>
            <p className="mb-0 text-[12px] text-[var(--dim)]">Tap the states to preview the system.</p>
          </aside>

          <div className="relative flex min-h-[420px] items-center justify-center p-5 sm:p-10">
            {activeMode === "Route" && <div className="w-full max-w-[560px] border-y border-[var(--border)]"><div className="grid grid-cols-[36px_1fr_auto] gap-4 border-b border-[var(--border)] py-6 text-[14px]"><span className="num text-[var(--dim)]">01</span><span>Define the argument</span><span className="text-[var(--accent)]">Now</span></div><div className="grid grid-cols-[36px_1fr_auto] gap-4 border-b border-[var(--border)] py-6 text-[14px] text-[var(--muted)]"><span className="num text-[var(--dim)]">02</span><span>Find the supporting source</span><span>Next</span></div><div className="grid grid-cols-[36px_1fr_auto] gap-4 py-6 text-[14px] text-[var(--dim)]"><span className="num">03</span><span>Write the first paragraph</span><span>Later</span></div></div>}
            {activeMode === "Focus" && <div className="relative w-full max-w-[600px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[#0d0f10] p-7 sm:p-12"><div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_55%,rgba(249,115,22,.12),transparent_36%)]" /><div className="relative flex items-center justify-between text-[11px] uppercase tracking-[.14em] text-[var(--dim)]"><span>Focus session</span><span className="mtdo-breathe flex items-center gap-2 text-[var(--live)]"><span className="h-1.5 w-1.5 rounded-full bg-[var(--live)]" />Live</span></div><div className="relative py-20 text-center"><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--muted)]">Deep work</p><div className="num mt-4 bg-[linear-gradient(180deg,#FFF,#8A8A93)] bg-clip-text text-[clamp(68px,9vw,112px)] font-black leading-none tracking-[-.065em] text-transparent">42:18</div></div><div className="relative h-px bg-white/[.12]"><div className="h-px w-[42%] bg-[var(--live)]" /></div></div>}
            {activeMode === "Proof" && <div className="w-full max-w-[560px]"><div className="mb-8 flex items-end justify-between"><div><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]">A week of work</p><p className="mb-0 mt-2 text-[17px] font-medium">Hours returned to the goal</p></div><span className="num text-[42px] font-bold tracking-[-.055em]">08:24</span></div><div className="grid grid-cols-7 gap-2">{heatmap.map((level, index) => <span key={index} className="aspect-square rounded-[var(--radius-sm)] transition-transform duration-200 hover:scale-110" style={{ backgroundColor: heatColors[level] }} />)}</div><p className="mb-0 mt-5 text-[12px] text-[var(--dim)]">A pattern, not a performance.</p></div>}
          </div>
        </div>
      </section>

      <section className="relative overflow-hidden border-y border-[var(--border)] bg-[#101214] px-[30px] py-24 md:py-[180px]">
        <div className="pointer-events-none absolute left-1/2 top-1/2 h-[620px] w-[820px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[rgba(34,211,238,.045)] blur-3xl" />
        <div className="relative mx-auto max-w-[1280px]">
          <Eyebrow>Focus is a place</Eyebrow>
          <div className="mt-8 grid gap-16 lg:grid-cols-[1.1fr_.9fr] lg:items-end"><h2 className="m-0 text-[clamp(54px,8vw,112px)] font-black leading-[.87] tracking-[-.065em]">The world gets<br />smaller when<br /><span className="text-[var(--muted)]">the work begins.</span></h2><div className="max-w-[370px] pb-3"><p className="m-0 text-[17px] font-light leading-7 text-[var(--muted)]">The focus state removes decisions from the edges. Ember appears only here: a signal that something is happening right now.</p><a href="#language" className="mt-8 inline-flex min-h-11 items-center border-b border-[var(--accent)] text-[13px] text-[var(--text)] transition-colors hover:text-[var(--accent)]">See the visual rules <span className="ml-2">→</span></a></div></div>
        </div>
      </section>

      <section className="mx-auto max-w-[1280px] px-[30px] py-24 md:py-[160px]">
        <div className="grid gap-12 lg:grid-cols-[.82fr_1.18fr] lg:items-center">
          <div><Eyebrow>Shared pace · concept preview</Eyebrow><h2 className="mb-0 mt-6 text-[clamp(38px,5vw,64px)] font-bold leading-[.95] tracking-[-.055em]">A study room without a podium.</h2><p className="mb-0 mt-7 max-w-[410px] font-light leading-7 text-[var(--muted)]">A timing board concept for friends moving toward the same goal. Lanes make the group visible without turning people into a ranking.</p></div>
          <div className="relative border-y border-[var(--border)] py-8 sm:p-10 sm:border">
            <div className="flex items-start justify-between"><div><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]">Room concept</p><h3 className="mb-0 mt-2 text-[24px] font-bold tracking-[-.035em]">Saturday revision</h3></div><span className="rounded-full border border-[var(--border)] px-3 py-2 text-[11px] text-[var(--muted)]">03 pacing</span></div>
            <div className="mt-12 space-y-7">{[["You", "43:12", 71, true], ["Nadia", "28:09", 49, false], ["Sam", "18:44", 32, false]].map(([name, time, width, live]) => <div key={String(name)}><div className="mb-3 flex items-center justify-between text-[13px]"><span>{name}</span><span className="num text-[var(--dim)]">{time}</span></div><div className="h-px bg-white/[.12]"><div className={`h-px ${live ? "bg-[var(--live)]" : "bg-[var(--accent)]"}`} style={{ width: `${width}%` }} /></div></div>)}</div>
          </div>
        </div>
      </section>

      <section id="language" className="border-y border-[var(--border)] bg-white/[.012]">
        <div className="mx-auto max-w-[1280px] px-[30px] py-24 md:py-[140px]">
          <div className="grid gap-12 lg:grid-cols-[.75fr_1.25fr]"><div><Eyebrow>The MTDO language</Eyebrow><h2 className="mb-0 mt-6 text-[clamp(38px,5vw,64px)] font-bold leading-[.95] tracking-[-.055em]">A system that knows when to disappear.</h2><p className="mb-0 mt-7 max-w-[390px] font-light leading-7 text-[var(--muted)]">One type family. One structural accent. Ember reserved for the present tense. Everything else is held by space, surface, and rhythm.</p></div>
            <div className="grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--border)] sm:grid-cols-2">
              <div className="min-h-[250px] bg-[var(--bg)] p-7"><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]">Actions</p><div className="mt-12 flex flex-wrap gap-3"><button type="button" className="min-h-11 rounded-full bg-[var(--accent)] px-5 text-[13px] font-medium text-[#061113] transition-transform hover:scale-[1.03] active:scale-[.98]">Begin focus</button><button type="button" className="min-h-11 rounded-full border border-[var(--border)] px-5 text-[13px] text-[var(--muted)] transition-colors hover:bg-[var(--surface-hover)] hover:text-[var(--text)]">Not now</button></div></div>
              <div className="min-h-[250px] bg-[var(--bg)] p-7"><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]">Input</p><div className="mt-12 border-b border-[var(--border)] pb-3 text-[14px] text-[var(--muted)]">What are you working toward?<span className="ml-1 inline-block h-4 w-px bg-[var(--accent)] align-middle" /></div><p className="mb-0 mt-4 text-[12px] text-[var(--dim)]">Clear language over visual noise.</p></div>
              <div className="min-h-[250px] bg-[var(--bg)] p-7"><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]">Surface</p><div className="mt-9 border border-[var(--border)] bg-[var(--surface)] p-5"><div className="flex items-center justify-between"><span className="text-[13px]">Weekly review</span><span className="text-[11px] text-[var(--accent)]">Open</span></div><p className="mb-0 mt-5 text-[12px] font-light leading-5 text-[var(--muted)]">Soft depth comes from translucency and a hairline, not from bulky cards.</p></div></div>
              <div className="min-h-[250px] bg-[var(--bg)] p-7"><p className="m-0 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]">Status</p><div className="mt-12 flex items-center gap-3 text-[13px]"><span className="mtdo-breathe h-2.5 w-2.5 rounded-full bg-[var(--live)]" />In session</div><p className="mb-0 mt-5 text-[12px] font-light leading-5 text-[var(--muted)]">Warmth means activity, never decoration.</p></div>
            </div>
          </div>
        </div>
      </section>

      <section id="closing" className="relative mx-auto flex min-h-[720px] max-w-[1280px] flex-col justify-between px-[30px] py-20 md:py-28">
        <div className="flex items-center justify-between border-b border-[var(--border)] pb-5 text-[11px] uppercase tracking-[.14em] text-[var(--dim)]"><span>MTDO / visual concept</span><span>2026</span></div>
        <div className="max-w-[900px]"><p className="m-0 text-[12px] uppercase tracking-[.14em] text-[var(--accent)]">For people going somewhere</p><h2 className="mb-0 mt-7 text-[clamp(54px,8.5vw,124px)] font-black leading-[.86] tracking-[-.07em]">Make room<br />for the work<br /><span className="text-[var(--muted)]">that matters.</span></h2><button type="button" onClick={() => setIsPaletteOpen(true)} className="mt-10 flex min-h-12 items-center rounded-full bg-[var(--text)] px-6 text-[13px] font-medium text-[var(--bg)] transition-transform hover:scale-[1.04] active:scale-[.98] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">Review the concept <span className="ml-2">↗</span></button></div>
        <footer className="flex flex-col gap-4 border-t border-[var(--border)] pt-5 text-[12px] text-[var(--dim)] sm:flex-row sm:justify-between"><span>Quietly serious.</span><a className="transition-colors hover:text-[var(--text)]" href="#arrival">Back to arrival ↑</a></footer>
      </section>

      {isPaletteOpen && <div role="dialog" aria-modal="true" aria-labelledby="concept-title" className="fixed inset-0 z-40 grid place-items-center bg-black/70 p-5 backdrop-blur-sm" onClick={() => setIsPaletteOpen(false)}><div className="w-full max-w-[620px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[#111315] p-6 shadow-[0_20px_80px_rgba(0,0,0,.65)] sm:p-9" onClick={(event) => event.stopPropagation()}><div className="flex items-start justify-between"><div><Eyebrow>Concept notes</Eyebrow><h2 id="concept-title" className="mb-0 mt-4 text-[30px] font-bold tracking-[-.045em]">MTDO, held to one idea.</h2></div><button type="button" onClick={() => setIsPaletteOpen(false)} className="grid h-11 w-11 place-items-center rounded-full border border-[var(--border)] text-[var(--muted)] transition-colors hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]" aria-label="Close concept notes">×</button></div><div className="mt-10 grid gap-px border-y border-[var(--border)] py-px sm:grid-cols-3">{[["Graphite", "Calm ground"], ["Cyan", "Structure"], ["Ember", "The present"]].map(([name, role]) => <div key={name} className="p-5"><p className="m-0 text-[15px] font-medium">{name}</p><p className="mb-0 mt-2 text-[12px] text-[var(--dim)]">{role}</p></div>)}</div><p className="mb-0 mt-8 max-w-[490px] font-light leading-7 text-[var(--muted)]">This prototype demonstrates a visual direction only: no account, API, database, or product workflow is connected.</p></div></div>}
    </main>
  );
}
