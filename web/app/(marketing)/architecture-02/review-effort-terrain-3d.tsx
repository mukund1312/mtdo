"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas, useFrame, useThree } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";
import * as THREE from "three";

import type { ConsistencyDay } from "@/lib/review/types";

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Real 3D "Effort Terrain" for the Review page -- a GitHub-contribution-
// style 52-week x 7-weekday grid extruded by review_consistency()'s
// server-computed Effort Score (migrations/0026/0027), same data the
// Heatmap view already renders. Ported from the visual-reference demo
// route's rebuilt terrain (architecture-02/review-demo) after the R3F/drei
// dependency was already added there -- see that route's EffortTerrain.tsx
// for the original build notes on grid alignment, nonlinear height, and
// camera framing.
//
// Honesty rule carried over from the Heatmap view: a day with level===null
// (no active plan that day, not "zero effort") renders as a bare base tile
// with no tower and no fabricated numbers in its tooltip -- never treated
// the same as a real 0.

const CELL_SIZE = 0.5;
const CELL_GAP = 0.28;
const SPACING = CELL_SIZE + CELL_GAP;

interface GridCell {
  day: ConsistencyDay | null;
  week: number;
  weekday: number;
}

function buildGrid(days: ConsistencyDay[]): GridCell[][] {
  if (days.length === 0) return [];
  const first = new Date(`${days[0]!.date}T00:00:00Z`);
  const firstWeekday = (first.getUTCDay() + 6) % 7;
  const padded: (ConsistencyDay | null)[] = [...Array(firstWeekday).fill(null), ...days];
  const weeks: GridCell[][] = [];
  for (let w = 0; w * 7 < padded.length; w++) {
    const week: GridCell[] = [];
    for (let d = 0; d < 7; d++) week.push({ day: padded[w * 7 + d] ?? null, week: w, weekday: d });
    weeks.push(week);
  }
  return weeks;
}

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
  cell: GridCell;
  selected: boolean;
  isToday: boolean;
  onHover: (day: ConsistencyDay | null, screen: { x: number; y: number } | null) => void;
}

// Towers grow upward from the base tile on mount -- never fall from above
// (audit item 43/25) -- 0.6s roughly matching the 500-900ms band the rest
// of the page's transitions use.
const GROW_SECONDS = 0.6;

function Block({ cell, selected, isToday, onHover }: BlockProps) {
  const [hovered, setHovered] = useState(false);
  const towerRef = useRef<THREE.Mesh>(null);
  const growRef = useRef(0);
  const x = cell.week * SPACING;
  const z = cell.weekday * SPACING;
  const day = cell.day;
  const hasScore = day != null && day.effort_score !== null;
  const score = hasScore ? day!.effort_score! : 0;
  const height = effortToHeight(score);
  const { color, emissive } = tierForScore(score);
  const hasTower = hasScore && score > 0;
  const restY = height / 2 + 0.04;

  useFrame((_, delta) => {
    if (!towerRef.current) return;
    if (growRef.current < 1) growRef.current = Math.min(1, growRef.current + delta / GROW_SECONDS);
    const eased = 1 - Math.pow(1 - growRef.current, 3); // ease-out cubic
    const hoverBump = hovered ? 1.04 : 1;
    towerRef.current.scale.y = eased * hoverBump;
    towerRef.current.position.y = restY * eased;
  });

  return (
    <group position={[x, 0, z]}>
      <mesh
        position={[0, 0.02, 0]}
        onPointerOver={(e) => {
          if (hasTower || !day) return;
          e.stopPropagation();
          setHovered(true);
          onHover(day, { x: (e.nativeEvent as PointerEvent).clientX, y: (e.nativeEvent as PointerEvent).clientY });
        }}
        onPointerOut={(e) => {
          if (hasTower || !day) return;
          e.stopPropagation();
          setHovered(false);
          onHover(null, null);
        }}
      >
        <boxGeometry args={[CELL_SIZE, 0.04, CELL_SIZE]} />
        <meshStandardMaterial
          color="#0c1426"
          emissive={isToday ? "#d7ff52" : "#000000"}
          emissiveIntensity={isToday ? (hovered ? 0.5 : 0.28) : 0}
          roughness={0.9}
          metalness={0}
        />
      </mesh>

      {/* Today's tile always gets a lime outline -- a base grid cell with
          no tower yet still needs to be findable as "this is where you
          are", per the empty-terrain spec (never a fabricated tower). */}
      {isToday && (
        <lineSegments position={[0, 0.045, 0]}>
          <edgesGeometry args={[new THREE.BoxGeometry(CELL_SIZE, 0.001, CELL_SIZE)]} />
          <lineBasicMaterial color="#d7ff52" />
        </lineSegments>
      )}

      {hasTower && (
        <mesh
          ref={towerRef}
          position={[0, 0, 0]}
          scale={[1, 0, 1]}
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

      {/* Today gets its own small purple marker even with no tower yet --
          "you are here", not "you have effort here" (that's the sphere
          above, reserved for the real peak day). */}
      {isToday && !selected && (
        <mesh position={[0, height + 0.18, 0]}>
          <sphereGeometry args={[0.06, 12, 12]} />
          <meshStandardMaterial color="#9c7cff" emissive="#9c7cff" emissiveIntensity={0.9} />
        </mesh>
      )}
    </group>
  );
}

function Scene({ weeks, todayDate, onHover }: { weeks: GridCell[][]; todayDate: string | null; onHover: BlockProps["onHover"] }) {
  const peakDate = useMemo(() => {
    let best: ConsistencyDay | null = null;
    for (const week of weeks) {
      for (const cell of week) {
        if (cell.day && cell.day.effort_score !== null && cell.day.effort_score > 0 && (!best || cell.day.effort_score > (best.effort_score ?? -1))) {
          best = cell.day;
        }
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
            <Block
              key={`${cell.week}-${cell.weekday}`}
              cell={cell}
              selected={cell.day?.date === peakDate}
              isToday={cell.day?.date === todayDate}
              onHover={onHover}
            />
          )),
        )}
      </group>
    </>
  );
}

function IsometricCamera({ gridWidth }: { gridWidth: number }) {
  const width = useThree((state) => state.size.width);
  const zoom = (width * 0.85) / (gridWidth * 0.86);

  return (
    <OrthographicCamera
      makeDefault
      position={[-16, 12, 22]}
      zoom={zoom}
      onUpdate={(cam) => cam.lookAt(0, 0.6, 0)}
    />
  );
}

export function ReviewEffortTerrain3D({ days }: { days: ConsistencyDay[] }) {
  const [hover, setHover] = useState<{ day: ConsistencyDay; left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const weeks = useMemo(() => buildGrid(days), [days]);
  const gridWidth = weeks.length * SPACING;
  const todayDate = days.at(-1)?.date ?? null;

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

  const handleHover = (day: ConsistencyDay | null, screen: { x: number; y: number } | null) => {
    if (day && screen && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setHover({
        day,
        left: Math.min(Math.max(screen.x - rect.left + 14, 4), rect.width - 230),
        top: Math.max(screen.y - rect.top - 90, 4),
      });
    } else {
      setHover(null);
    }
  };

  const isToday = hover?.day.date === todayDate;
  const hasEffort = hover != null && hover.day.effort_score !== null && hover.day.effort_score > 0;

  return (
    <div>
      <div className="a02-terrain-3d-wrap" ref={wrapRef}>
        <Canvas dpr={[1, 1.5]} gl={{ antialias: true }}>
          <IsometricCamera gridWidth={gridWidth} />
          <Scene weeks={weeks} todayDate={todayDate} onHover={handleHover} />
        </Canvas>
        {hover && (
          <div className="a02-terrain-tooltip" style={{ left: hover.left, top: hover.top, position: "absolute" }}>
            {isToday && !hasEffort ? (
              <>
                <b>Today</b>
                <p>No effort recorded yet. Start your first session to grow your terrain.</p>
              </>
            ) : hasEffort ? (
              <>
                <b>{hover.day.date}</b>
                <div className="a02-terrain-tooltip-row"><span>Effort</span><b>{hover.day.effort_score}</b></div>
                {hover.day.focus_percentage != null && (
                  <div className="a02-terrain-tooltip-row"><span>Focus</span><b>{hover.day.focus_percentage}%</b></div>
                )}
                {hover.day.execute_percentage != null && (
                  <div className="a02-terrain-tooltip-row"><span>Execute</span><b>{hover.day.execute_percentage}%</b></div>
                )}
              </>
            ) : (
              <>
                <b>{hover.day.date}</b>
                <p>No activity</p>
              </>
            )}
          </div>
        )}
      </div>
      <div className="a02-terrain-3d-months">
        {monthLabels.map(({ name, weekIndex }) => (
          <span key={`${name}-${weekIndex}`} style={{ left: `${(weekIndex / weeks.length) * 100}%` }}>{name}</span>
        ))}
      </div>
      <p className="a02-terrain-3d-annotation">Every focused day adds to your terrain.</p>
    </div>
  );
}
