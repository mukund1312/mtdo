"use client";

import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Sparkle } from "lucide-react";

// Fixed hourly shape matching the reference screenshot's distribution
// (peak ~09:00) -- this demo route's data is synthetic throughout, see
// data/review-demo-data.ts's header.
const HOURLY = [2, 1, 2, 3, 2, 3, 8, 16, 28, 42, 38, 29, 20, 15, 11, 13, 12, 20, 23, 10, 8, 7, 5, 2];
const PEAK_HOUR = 9;

const chartData = HOURLY.map((minutes, hour) => ({ hour, minutes }));
const totalMinutes = HOURLY.reduce((a, b) => a + b, 0);

function formatTotal(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}h ${m}m`;
}

export function FocusDistribution() {
  return (
    <section className="rd-card" aria-label="Focus time distribution">
      <div className="rd-focus-dist-head">
        <span className="rd-card-title" style={{ padding: 0 }}>FOCUS TIME DISTRIBUTION</span>
        <div className="rd-focus-dist-total">
          Total Focus
          <b>{formatTotal(totalMinutes)}</b>
        </div>
      </div>
      <div className="rd-focus-dist-chart" style={{ height: 140, position: "relative" }}>
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
            <XAxis
              dataKey="hour"
              ticks={[0, 3, 6, 9, 12, 15, 18, 21]}
              tickFormatter={(h) => String(h).padStart(2, "0")}
              tick={{ fill: "#737d9e", fontSize: 10 }}
              axisLine={{ stroke: "rgba(105,125,180,0.16)" }}
              tickLine={false}
              interval={0}
            />
            <Tooltip
              cursor={{ fill: "rgba(139,92,246,0.08)" }}
              contentStyle={{ background: "#0a1020", border: "1px solid rgba(105,125,180,0.16)", borderRadius: 8, fontSize: 12 }}
              labelFormatter={(h) => `${String(h).padStart(2, "0")}:00`}
              formatter={(v) => [`${v} min`, "Focus"]}
            />
            <Bar dataKey="minutes" radius={[2, 2, 0, 0]}>
              {chartData.map((d) => (
                <Cell key={d.hour} fill={d.hour === PEAK_HOUR ? "#a66bff" : "#8b5cf6"} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
        <Sparkle
          size={14}
          color="#3dd9ff"
          style={{ position: "absolute", top: 4, left: `${(PEAK_HOUR / 23) * 92 + 2}%` }}
          aria-hidden="true"
        />
      </div>
      <p className="rd-focus-dist-footer">
        You are <b>31%</b> more likely to complete tasks when you start before 10 AM.
      </p>
    </section>
  );
}
