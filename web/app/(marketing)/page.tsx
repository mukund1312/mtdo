const routeSteps = [
  ["01", "Set the goal", "Name the outcome you are working toward."],
  ["02", "Follow the route", "Keep the next useful step in view."],
  ["03", "Make the time", "Give one task your full attention."],
] as const;

const roomLanes = [
  ["You", "In focus", "72%"],
  ["Mira", "Reviewing", "48%"],
  ["Arun", "On a break", "31%"],
] as const;

const proofDays = [0, 1, 0, 2, 3, 0, 1, 2, 0, 4, 2, 1, 0, 3, 4, 2, 1, 3, 0, 2, 4] as const;

const quietFeatures = [
  ["Learn", "Keep the material beside the work."],
  ["Media", "Bring useful source material into one view."],
  ["Growth", "See the record change without inflated scores."],
] as const;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="m-0 text-[11.5px] font-normal uppercase tracking-[0.14em] text-[var(--accent)]">{children}</p>;
}

export default function MarketingHomePage() {
  return (
    <main className="min-h-dvh overflow-hidden bg-[var(--bg)]">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-[radial-gradient(ellipse_80%_50%_at_50%_-10%,rgba(34,211,238,.09),transparent_70%)]" />
      <nav aria-label="Primary navigation" className="fixed left-1/2 top-5 z-20 flex min-h-11 w-[calc(100%-32px)] max-w-[680px] -translate-x-1/2 items-center justify-between rounded-full border border-[var(--border)] bg-[rgba(11,11,12,.76)] px-3 py-2 backdrop-blur-xl sm:px-4">
        <a href="#top" className="flex min-h-11 items-center rounded-full px-3 text-[15px] font-bold tracking-[-0.02em] outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]">mtdo</a>
        <div className="hidden items-center gap-1 sm:flex">
          {[["Focus", "#focus"], ["Rooms", "#rooms"], ["Proof", "#proof"]].map(([label, href]) => <a key={href} href={href} className="flex min-h-11 items-center rounded-full px-4 text-[13.5px] text-[var(--muted)] outline-none transition-colors hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">{label}</a>)}
        </div>
        <a href="#route" className="flex min-h-11 items-center rounded-full bg-[var(--text)] px-5 text-[13.5px] font-medium text-[var(--bg)] outline-none transition-transform duration-200 ease-[var(--ease-spring)] hover:scale-[1.045] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">Start</a>
      </nav>

      <section id="top" className="relative mx-auto grid min-h-[760px] max-w-[1080px] items-end gap-12 px-[30px] pb-20 pt-[186px] lg:grid-cols-[1.08fr_.92fr] lg:pb-[100px]">
        <div className="max-w-[720px] self-center">
          <div className="mb-8 inline-flex min-h-11 items-center gap-3 rounded-full border border-[var(--border)] bg-[var(--surface)] px-4 text-[13px] text-[var(--muted)]"><span className="relative flex h-2.5 w-2.5" aria-hidden="true"><span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--live)] opacity-50" /><span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--live)]" /></span>Focus is happening now</div>
          <h1 className="m-0 max-w-[780px] text-[clamp(44px,7vw,88px)] font-black leading-[.94] tracking-[-0.045em]">Turn a serious goal into today&apos;s work.</h1>
          <p className="mb-0 mt-8 max-w-[590px] text-[17px] font-light leading-7 text-[var(--muted)]">A calm place to plan the route, focus on the next step, and keep honest proof that you moved.</p>
          <div className="mt-10 flex flex-wrap gap-3"><a href="#route" className="flex min-h-11 items-center rounded-full bg-[var(--accent)] px-6 text-[13.5px] font-medium text-[#061113] outline-none transition-transform duration-200 ease-[var(--ease-spring)] hover:scale-[1.045] focus-visible:ring-2 focus-visible:ring-white">Build your goal route</a><a href="#focus" className="flex min-h-11 items-center rounded-full border border-[var(--border)] px-6 text-[13.5px] text-[var(--muted)] outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">See the focus flow</a></div>
        </div>
        <div className="relative mx-auto w-full max-w-[420px] rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-5 lg:mb-2">
          <div className="mb-12 flex items-center justify-between text-[11.5px] uppercase tracking-[0.14em] text-[var(--dim)]"><span>Today</span><span className="num">01 / 03</span></div><p className="mb-3 text-[12px] uppercase tracking-[0.14em] text-[var(--accent)]">Next step</p><h2 className="m-0 text-[25px] font-bold leading-tight tracking-[-0.035em]">Work through the first hard part.</h2><p className="mb-8 mt-4 font-light leading-6 text-[var(--muted)]">The route stays quiet until you need the next decision.</p><div className="h-1 overflow-hidden rounded-full bg-white/[.06]"><div className="h-full w-[38%] rounded-full bg-[var(--accent)]" /></div>
        </div>
      </section>

      <section id="route" className="border-y border-[var(--border)]"><div className="mx-auto max-w-[1080px] px-[30px] py-16 md:py-[100px]"><div className="grid gap-12 lg:grid-cols-[.75fr_1.25fr]">
        <div><Eyebrow>Plan</Eyebrow><h2 className="mb-5 mt-4 text-[clamp(28px,3.6vw,44px)] font-bold leading-[1.04] tracking-[-0.035em]">A route before a checklist.</h2><p className="max-w-[420px] font-light leading-7 text-[var(--muted)]">Start with the outcome. Break it down only far enough to make today clear.</p></div>
        <ol className="m-0 grid list-none gap-px overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--border)] p-0">{routeSteps.map(([number, title, body]) => <li key={number} className="grid gap-3 bg-[var(--bg)] p-6 sm:grid-cols-[52px_160px_1fr] sm:items-center"><span className="num text-[12px] text-[var(--dim)]">{number}</span><strong className="text-[16px] tracking-[-0.015em]">{title}</strong><span className="font-light leading-6 text-[var(--muted)]">{body}</span></li>)}</ol>
      </div></div></section>

      <section id="focus" className="mx-auto max-w-[1080px] px-[30px] py-16 md:py-[100px]">
        <div className="mb-12 max-w-[620px]"><Eyebrow>Focus · coaching preview</Eyebrow><h2 className="mb-5 mt-4 text-[clamp(28px,3.6vw,44px)] font-bold leading-[1.04] tracking-[-0.035em]">One task. The time to do it. Context within reach.</h2><p className="font-light leading-7 text-[var(--muted)]">A static preview of the focused session surface and its supporting guidance.</p></div>
        <div className="grid min-h-[520px] overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[#101316] lg:grid-cols-[1fr_252px]">
          <div className="flex min-h-[390px] flex-col items-center justify-center border-b border-[var(--border)] p-8 lg:border-b-0 lg:border-r"><span className="mb-7 text-[11.5px] uppercase tracking-[0.14em] text-[var(--dim)]">Deep work · running</span><div className="num bg-[linear-gradient(180deg,#FFF,#8A8A93)] bg-clip-text text-[clamp(58px,9.5vw,110px)] font-black leading-none tracking-[-0.055em] text-transparent">42:18</div><div className="mt-10 h-1 w-full max-w-[440px] overflow-hidden rounded-full bg-white/[.06]"><div className="h-full w-[42%] rounded-full bg-[var(--live)]" /></div></div>
          <aside className="flex flex-col justify-between bg-white/[.018] p-6"><div><p className="text-[11.5px] uppercase tracking-[0.14em] text-[var(--dim)]">On this step</p><h3 className="mt-5 text-[16px] font-bold tracking-[-0.015em]">Keep the problem small.</h3><p className="mt-3 font-light leading-6 text-[var(--muted)]">Placeholder guidance stays beside the work without taking over the screen.</p></div><span className="text-[12px] text-[var(--dim)]">Static product preview</span></aside>
        </div>
      </section>

      <section id="rooms" className="border-y border-[var(--border)] bg-white/[.012]"><div className="mx-auto grid max-w-[1080px] gap-12 px-[30px] py-16 md:py-[100px] lg:grid-cols-[.78fr_1.22fr] lg:items-center">
        <div><Eyebrow>Social · rooms preview</Eyebrow><h2 className="mb-5 mt-4 text-[clamp(28px,3.6vw,44px)] font-bold leading-[1.04] tracking-[-0.035em]">Together, without turning study into a ranking.</h2><p className="font-light leading-7 text-[var(--muted)]">A visual direction for shared timing: individual lanes, one group rhythm, no podium.</p></div>
        <div className="rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-6 sm:p-8"><div className="mb-8 flex items-center justify-between"><div><p className="m-0 text-[11.5px] uppercase tracking-[0.14em] text-[var(--dim)]">Study room preview</p><h3 className="mb-0 mt-2 text-[20px] font-bold tracking-[-0.025em]">Saturday revision</h3></div><span className="num rounded-full border border-[var(--border)] px-3 py-2 text-[12px] text-[var(--muted)]">03 people</span></div><div className="space-y-6">{roomLanes.map(([name, state, width], index) => <div key={name}><div className="mb-2 flex justify-between text-[13px]"><span>{name}</span><span className="text-[var(--dim)]">{state}</span></div><div className="h-1.5 overflow-hidden rounded-full bg-white/[.06]"><div className={`h-full rounded-full ${index === 0 ? "bg-[var(--live)]" : "bg-[var(--accent)]"}`} style={{ width }} /></div></div>)}</div></div>
      </div></section>

      <section id="proof" className="mx-auto max-w-[1080px] px-[30px] py-16 md:py-[100px]"><div className="grid gap-10 lg:grid-cols-[1.05fr_.95fr] lg:items-stretch">
        <div className="flex min-h-[500px] flex-col justify-between rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--surface)] p-7 sm:p-10"><div><Eyebrow>Proof</Eyebrow><h2 className="mb-5 mt-4 max-w-[520px] text-[clamp(28px,3.6vw,44px)] font-bold leading-[1.04] tracking-[-0.035em]">A record that says exactly what happened.</h2><p className="max-w-[520px] font-light leading-7 text-[var(--muted)]">Sessions completed. Days returned. Work moved. No invented score between you and the facts.</p></div><div><div className="mb-4 flex items-end justify-between"><span className="text-[12px] uppercase tracking-[0.14em] text-[var(--dim)]">Recent work</span><span className="num text-[34px] font-bold tracking-[-0.04em]">08h 24m</span></div><div className="grid grid-cols-7 gap-2" aria-label="Illustrative activity heatmap">{proofDays.map((level, index) => <span key={index} className="aspect-square rounded-[var(--radius-sm)]" style={{ backgroundColor: ["rgba(255,255,255,.06)", "#0E7490", "#0891B2", "#06B6D4", "#22D3EE"][level] }} />)}</div></div></div>
        <div className="flex min-h-[500px] items-center justify-center rounded-[var(--radius-xl)] border border-[var(--border)] bg-[#0f1012] p-8"><div className="aspect-[9/16] h-[410px] max-h-full rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--bg)] p-6"><p className="m-0 text-[11px] uppercase tracking-[0.14em] text-[var(--accent)]">Milestone record</p><div className="mt-20"><span className="num bg-[linear-gradient(180deg,#FFF,#8A8A93)] bg-clip-text text-[52px] font-black tracking-[-0.055em] text-transparent">12</span><p className="mt-1 text-[14px] text-[var(--muted)]">focused sessions</p></div><div className="mt-24 border-t border-[var(--border)] pt-5 text-[11px] text-[var(--dim)]">1080 × 1920 · export preview</div></div></div>
      </div></section>

      <section className="border-t border-[var(--border)]"><div className="mx-auto max-w-[1080px] px-[30px] py-16 md:py-[100px]"><Eyebrow>The rest stays quiet</Eyebrow><div className="mt-8 grid gap-px overflow-hidden rounded-[var(--radius-xl)] border border-[var(--border)] bg-[var(--border)] md:grid-cols-3">{quietFeatures.map(([title, body]) => <div key={title} className="min-h-[190px] bg-[var(--bg)] p-7"><h3 className="m-0 text-[16px] font-bold tracking-[-0.015em]">{title}</h3><p className="mt-4 max-w-[250px] font-light leading-6 text-[var(--muted)]">{body}</p></div>)}</div></div></section>
      <footer className="mx-auto flex max-w-[1080px] flex-col gap-8 px-[30px] py-16 sm:flex-row sm:items-end sm:justify-between"><div><p className="m-0 text-[28px] font-black tracking-[-0.04em]">mtdo</p><p className="mb-0 mt-3 text-[13px] text-[var(--dim)]">Built for people going somewhere.</p></div><a href="#top" className="flex min-h-11 items-center text-[13px] text-[var(--muted)] outline-none hover:text-[var(--text)] focus-visible:ring-2 focus-visible:ring-[var(--accent)]">Back to top ↑</a></footer>
    </main>
  );
}
