"use client";

import { useMemo, useRef, useState } from "react";
import { Canvas } from "@react-three/fiber";
import { OrthographicCamera } from "@react-three/drei";

import type { ReviewDemoDay } from "@/data/review-demo-data";

const MONTH_LABELS = ["Oct", "Nov", "Dec", "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"];

function colorForScore(score: number): string {
  if (score <= 0) return "#111a31";
  if (score < 30) return "#1f6b4a";
  if (score < 60) return "#4fae5e";
  if (score < 85) return "#a8f45d";
  return "#c8ff5d";
}

interface BlockProps {
  day: ReviewDemoDay;
  x: number;
  z: number;
  selected: boolean;
  onHover: (day: ReviewDemoDay | null, screen: { x: number; y: number } | null) => void;
}

function Block({ day, x, z, selected, onHover }: BlockProps) {
  const [hovered, setHovered] = useState(false);
  const height = Math.max(0.06, (day.effortScore / 100) * 3.2);
  const color = colorForScore(day.effortScore);

  return (
    <mesh
      position={[x, height / 2, z]}
      scale={[hovered ? 1.15 : 1, hovered ? 1.08 : 1, hovered ? 1.15 : 1]}
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
      <boxGeometry args={[0.62, height, 0.62]} />
      <meshStandardMaterial
        color={color}
        emissive={color}
        emissiveIntensity={hovered ? 0.9 : 0.35}
        transparent
        opacity={day.effortScore <= 0 ? 0.35 : 0.92}
      />
      {selected && (
        <mesh position={[0, height / 2 + 0.18, 0]}>
          <sphereGeometry args={[0.09, 12, 12]} />
          <meshStandardMaterial color="#8b5cf6" emissive="#8b5cf6" emissiveIntensity={1} />
        </mesh>
      )}
    </mesh>
  );
}

function Scene({ days, onHover }: { days: ReviewDemoDay[]; onHover: BlockProps["onHover"] }) {
  const weeks = useMemo(() => {
    const chunks: ReviewDemoDay[][] = [];
    for (let i = 0; i < days.length; i += 7) chunks.push(days.slice(i, i + 7));
    return chunks;
  }, [days]);

  const peakDay = useMemo(() => days.reduce((max, d) => (d.effortScore > max.effortScore ? d : max), days[0]!), [days]);

  return (
    <>
      <ambientLight intensity={0.6} />
      <directionalLight position={[8, 12, 6]} intensity={0.7} />
      <group position={[-(weeks.length * 0.62) / 2, 0, -2]}>
        {weeks.map((week, wi) =>
          week.map((day, di) => (
            <Block
              key={day.date}
              day={day}
              x={wi * 0.62}
              z={di * 0.62}
              selected={day.date === peakDay.date}
              onHover={onHover}
            />
          )),
        )}
        <gridHelper args={[weeks.length * 0.62, weeks.length, "#1c2440", "#10162c"]} position={[weeks.length * 0.31, 0, 2]} />
      </group>
    </>
  );
}

export function EffortTerrain({ days }: { days: ReviewDemoDay[] }) {
  const [hover, setHover] = useState<{ day: ReviewDemoDay; left: number; top: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const handleHover = (day: ReviewDemoDay | null, screen: { x: number; y: number } | null) => {
    if (day && screen && wrapRef.current) {
      const rect = wrapRef.current.getBoundingClientRect();
      setHover({
        day,
        left: Math.min(screen.x - rect.left + 12, rect.width - 170),
        top: Math.max(screen.y - rect.top - 90, 4),
      });
    } else {
      setHover(null);
    }
  };

  const isPeak = hover && days.reduce((max, d) => (d.effortScore > max.effortScore ? d : max), days[0]!).date === hover.day.date;

  return (
    <div>
      <div className="rd-terrain-wrap" ref={wrapRef}>
        <Canvas dpr={[1, 1.5]} gl={{ antialias: true }}>
          <OrthographicCamera
            makeDefault
            position={[10, 16, 34]}
            zoom={13}
            onUpdate={(cam) => cam.lookAt(0, 0, 0)}
          />
          <Scene days={days} onHover={handleHover} />
        </Canvas>
        {hover && (
          <div
            className="rd-terrain-tooltip"
            style={{ left: hover.left, top: hover.top }}
          >
            <b>
              {new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(
                new Date(`${hover.day.date}T00:00:00Z`),
              )}
            </b>
            <span>Effort {hover.day.effortScore}</span><br />
            <span>Focus {hover.day.focusMinutes} min</span><br />
            <span>Completed {hover.day.tasksCompleted} / {hover.day.tasksPlanned}</span>
            {isPeak && <div className="rd-peak-badge">Peak day</div>}
          </div>
        )}
      </div>
      <div className="rd-terrain-months">
        {MONTH_LABELS.map((m) => <span key={m}>{m}</span>)}
      </div>
    </div>
  );
}
