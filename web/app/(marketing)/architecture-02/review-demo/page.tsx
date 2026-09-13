"use client";

import "./review-demo.css";

import { motion } from "framer-motion";

import { getReviewDemoDays, getReviewDemoToday } from "@/data/review-demo-data";
import { activeDaysStats } from "@/lib/review-demo/analytics";

import { TopNavigation } from "@/components/layout-demo/TopNavigation";
import { MusicPlayer } from "@/components/layout-demo/MusicPlayer";
import { ReviewSidebar } from "@/components/review-demo/ReviewSidebar";
import { ReviewHeader } from "@/components/review-demo/ReviewHeader";
import { PrimaryMetrics } from "@/components/review-demo/PrimaryMetrics";
import { TodaysSignal } from "@/components/review-demo/TodaysSignal";
import { InsightList } from "@/components/review-demo/InsightList";
import { FocusDistribution } from "@/components/review-demo/FocusDistribution";
import { ConsistencyHeatmap } from "@/components/review-demo/ConsistencyHeatmap";
import { SessionQuality } from "@/components/review-demo/SessionQuality";
import { PlanReality } from "@/components/review-demo/PlanReality";
import { SubjectBalance } from "@/components/review-demo/SubjectBalance";

const fadeUp = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
};

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  return (
    <motion.div variants={fadeUp} initial="hidden" animate="show" transition={{ duration: 0.4, delay, ease: "easeOut" }}>
      {children}
    </motion.div>
  );
}

// Visual-reference demo route: fully-populated with a deterministic, seeded
// mock 365-day dataset (data/review-demo-data.ts) so a reviewer can compare
// this against a reference screenshot without needing real usage history.
// This is NOT wired to Supabase and never will be -- the real Review page
// lives at /architecture-02?deck=review and reads review_daily_summary(),
// review_consistency(), and study_profile() honestly (empty states when
// there's no data, never a fabricated number). See that page's own review-*
// components for the production implementation.
export default function ReviewDemoPage() {
  const days = getReviewDemoDays();
  const today = getReviewDemoToday();
  const stats = activeDaysStats(days.slice(-42));

  return (
    <div className="rd-root">
      <div className="rd-grid-overlay" aria-hidden="true" />
      <TopNavigation />
      <div className="rd-shell">
        <ReviewSidebar />
        <main className="rd-main">
          <Reveal>
            <ReviewHeader />
          </Reveal>
          <Reveal delay={0.03}>
            <PrimaryMetrics today={today} dailyScore={71} streak={stats.currentStreak} activeDaysRate={stats.activeDaysRate} />
          </Reveal>

          <div className="rd-signal-row">
            <Reveal delay={0.06}><TodaysSignal today={today} /></Reveal>
            <Reveal delay={0.08}><InsightList /></Reveal>
            <Reveal delay={0.1}><FocusDistribution /></Reveal>
          </div>

          <Reveal delay={0.12}>
            <ConsistencyHeatmap days={days} />
          </Reveal>

          <div className="rd-third-row">
            <Reveal delay={0.14}><SessionQuality days={days} /></Reveal>
            <Reveal delay={0.16}><PlanReality days={days} /></Reveal>
            <Reveal delay={0.18}><SubjectBalance days={days} /></Reveal>
          </div>
        </main>
      </div>
      <MusicPlayer />
    </div>
  );
}
