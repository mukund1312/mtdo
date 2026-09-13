"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";

import type { ReviewDemoDay } from "@/data/review-demo-data";

// Rebuilt to read as an actual GitHub contribution calendar extruded into a
// 3D skyline: a real 52-week x 7-day GRID (fixed x/z per day, not 365 blocks
// laid out sequentially), individually-gapped towers, a nonlinear height
// curve so peak days dominate, and a visible base tile grid under every
// cell (active or not). See the reference "GitHub 3D Contributions" viewer
// this was rebuilt against -- this is NOT a generic Three.js bar chart.

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const CELL_SIZE = 0.5;
const CELL_GAP = 0.28;
const SPACING = CELL_SIZE + CELL_GAP;

interface GridDay {
  day: ReviewDemoDay | null;
  week: number;
  weekday: number; // 0 = Mon .. 6 = Sun
}

function buildGrid(days: ReviewDemoDay[]): GridDay[][] {
  if (days.length === 0) return [];
  const first = new Date(`${days[0]!.date}T00:00:00Z`);
  const firstWeekday = (first.getUTCDay() + 6) % 7;
  const padded: (ReviewDemoDay | null)[] = [...Array(firstWeekday).fill(null), ...days];
  const weeks: GridDay[][] = [];
  for (let w = 0; w * 7 < padded.length; w++) {
    const week: GridDay[] = [];
    for (let d = 0; d < 7; d++) {
      week.push({ day: padded[w * 7 + d] ?? null, week: w, weekday: d });
    }
    weeks.push(week);
  }
  return weeks;
}

// Nonlinear so a 90+ day towers dramatically over a 40-50 day -- a uniform
// wall was the single biggest complaint with the previous version.
function effortToHeight(score: number): number {
  if (score <= 0) return 0.08;
  return 0.1 + Math.pow(score / 100, 2.1) * 5.0;
}

function tierForScore(score: number): { color: string; emissive: number } {
  if (score <= 0) return { color: "#16251e", emissive: 0.03 };
  if (score < 20) return { color: "#16251e", emissive: 0.05 };
  if (score < 40) return { color: "#315c35", emissive: 0.07 };
  if (score < 60) return { color: "#5f9d45", emissive: 0.12 };
  if (score < 78) return { color: "#93d74e", emissive: 0.2 };
  if (score < 92) return { color: "#bfff5f", emissive: 0.3 };
  return { color: "#d5ff74", emissive: 0.42 };
}

interface BlockProps {
  cell: GridDay;
  selected: boolean;
  onHover: (day: ReviewDemoDay | null, screen: { x: number; y: number } | null) => void;
}

function Block({ cell, selected, onHover }: BlockProps) {
  const [hovered, setHovered] = useState(false);
  const x = cell.week * SPACING;
  const z = cell.weekday * SPACING;
  const day = cell.day;
  const score = day?.effortScore ?? 0;
  const height = effortToHeight(score);
  const { color, emissive } = tierForScore(score);

  return (
    <group position={[x, 0, z]}>
      {/* base tile -- keeps the underlying 52x7 grid visible under every
          cell, active or not, so this reads as a contribution calendar
          rather than a floating cluster of bars. */}
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[CELL_SIZE, 0.04, CELL_SIZE]} />
        <meshStandardMaterial color="#0c1426" roughness={0.9} metalness={0} />
      </mesh>

      {day && score > 0 && (
        <mesh
          position={[0, height / 2 + 0.04, 0]}
          scale={[1, hovered ? 1.04 : 1, 1]}
          onPointerOver={(e) => {
            e.stopPropagation();
            setHovered(true);
            onHover(day, { x: (e.nativeEvent as PointerEvent).clientX, y: (e.nativeEvent as PointerEvent).clientY });
          }}
          onPointerOut={(e) => {
            e.stopPropagation();
            setHovered(false);
            onHover(null, null);
          }}
        >
          <boxGeometry args={[CELL_SIZE, height, CELL_SIZE]} />
          <meshStandardMaterial
            color={color}
            emissive={color}
            emissiveIntensity={hovered ? emissive + 0.5 : emissive}
            roughness={0.65}
            metalness={0.04}
          />
        </mesh>
      )}

      {selected && day && (
        <mesh position={[0, height + 0.22, 0]}>
          <sphereGeometry args={[0.08, 12, 12]} />
          <meshStandardMaterial color="#9c7cff" emissive="#9c7cff" emissiveIntensity={1.1} />
        </mesh>
      )}
    </group>
  );
}

function Scene({ weeks, onHover }: { weeks: GridDay[][]; onHover: BlockProps["onHover"] }) {
  const peakDate = useMemo(() => {
    let best: ReviewDemoDay | null = null;
    for (const week of weeks) {
      for (const cell of week) {
        if (cell.day && (!best || cell.day.effortScore > best.effortScore)) best = cell.day;
      }
    }
    return best?.date ?? null;
  }, [weeks]);

  const gridWidth = weeks.length * SPACING;
  const gridDepth = 7 * SPACING;

  return (
    <>
      <ambientLight intensity={0.8} />
      <directionalLight position={[-10, 16, 10]} intensity={1.8} />
      <directionalLight position={[10, 6, -10]} intensity={0.4} />
      <group position={[-gridWidth / 2, 0, -gridDepth / 2]}>
        {weeks.map((week) =>
          week.map((cell) => (
            <Block key={`${cell.week}-${cell.weekday}`} cell={cell} selected={cell.day?.date === peakDate} onHover={onHover} />
          )),
        )}
      </group>
    </>
  );
}

function IsometricCamera({ gridWidth }: { gridWidth: number }) {
  const width = useThree((state) => state.size.width);
  // Fill ~85% of the card width with the grid's full horizontal span,
  // recomputed whenever the canvas is resized. Foreshortening from the
  // isometric yaw/pitch below shrinks the projected width relative to true
  // world width -- 0.86 compensates so the grid still visually reaches
  // ~85%. Passed as a prop (not mutated on the camera instance) so drei's
  // own zoom-change handling keeps the projection matrix in sync.
  const zoom = (width * 0.85) / (gridWidth * 0.86);

  return (
    <OrthographicCamera
      makeDefault
      // Low isometric angle: ~35 deg pitch, ~30 deg yaw, front-left
      // viewpoint -- a chart, not a game camera. No orbit controls, no
      // auto-rotation.
      position={[-16, 12, 22]}
      zoom={zoom}
      onUpdate={(cam) => cam.lookAt(0, 0.6, 0)}
    />
  );
}

export function EffortTerrain({ days }: { days: ReviewDemoDay[] }) {
  const [hover, setHover] = useState<{ day: ReviewDemoDay; left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const weeks = useMemo(() => buildGrid(days), [days]);
  const gridWidth = weeks.length * SPACING;

  const monthLabels = useMemo(() => {
    const labels: Array<{ name: string; weekIndex: number }> = [];
    let prevMonth: number | null = null;
    weeks.forEach((week, wi) => {
      const firstReal = week.find((c) => c.day !== null)?.day;
      if (!firstReal) return;
      const month = new Date(`${firstReal.date}T00:00:00Z`).getUTCMonth();
      if (month !== prevMonth) {
        labels.push({ name: MONTH_NAMES[month]!, weekIndex: wi });
        prevMonth = month;
      }
    });
    return labels;
  }, [weeks]);

  const handleHover = (day: ReviewDemoDay | null, screen: { x: number; y: number } | null) => {
    if (day && screen && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setHover({
        day,
        left: Math.min(Math.max(screen.x - rect.left + 14, 4), rect.width - 230),
        top: Math.max(screen.y - rect.top - 100, 4),
      });
    } else {
      setHover(null);
    }
  };

  const isPeak = useMemo(() => {
    if (!hover) return false;
    let best = days[0]!;
    for (const d of days) if (d.effortScore > best.effortScore) best = d;
    return best.date === hover.day.date;
  }, [hover, days]);

  return (
    <div>
      <div className="rd-terrain-wrap" ref={wrapRef}>
        <Canvas dpr={[1, 1.5]} gl={{ antialias: true }}>
          <IsometricCamera gridWidth={gridWidth} />
          <Scene weeks={weeks} onHover={handleHover} />
        </Canvas>
        {hover && (
          <div className="rd-terrain-tooltip" style={{ left: hover.left, top: hover.top }}>
            <b>
              {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
                new Date(`${hover.day.date}T00:00:00Z`),
              )}
            </b>
            <div className="rd-terrain-tooltip-row"><span>Effort</span><b>{hover.day.effortScore}</b></div>
            <div className="rd-terrain-tooltip-row"><span>Focus</span><b>{hover.day.focusMinutes} min</b></div>
            <div className="rd-terrain-tooltip-row"><span>Completed</span><b>{hover.day.tasksCompleted} / {hover.day.tasksPlanned}</b></div>
            {isPeak && <div className="rd-peak-badge">Peak day</div>}
          </div>
        )}
      </div>
      <div className="rd-terrain-months" style={{ position: "relative", display: "block", height: 16 }}>
        {monthLabels.map(({ name, weekIndex }) => (
          <span key={`${name}-${weekIndex}`} style={{ position: "absolute", left: `${(weekIndex / weeks.length) * 100}%` }}>{name}</span>
        ))}
      </div>
    </div>
  );
}
