"use client";

import { useEffect, useRef } from "react";

type FocusCompletionConfettiProps = { onComplete: () => void };

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  width: number;
  height: number;
  rotation: number;
  rotationVelocity: number;
  color: string;
};

const DURATION_MS = 1550;
const COLORS = ["#d7ff52", "#57e7ff", "#8975ff", "#e9ebff"];

/** A short canvas burst with real gravity, spin, and screen-edge collision. */
export function FocusCompletionConfetti({ onComplete }: FocusCompletionConfettiProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const timeout = window.setTimeout(onComplete, 180);
      return () => window.clearTimeout(timeout);
    }

    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;

    const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
    let width = 0;
    let height = 0;
    const resize = () => {
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
    };
    resize();
    window.addEventListener("resize", resize);

    const particles: Particle[] = Array.from({ length: 58 }, (_, index) => {
      const angle = (Math.PI * 2 * index) / 58 + (Math.random() - 0.5) * 0.42;
      const speed = 4.8 + Math.random() * 8.4;
      return {
        x: width / 2,
        y: height / 2,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2.8,
        width: 4 + Math.random() * 4,
        height: 6 + Math.random() * 6,
        rotation: Math.random() * Math.PI,
        rotationVelocity: (Math.random() - 0.5) * 0.42,
        color: COLORS[index % COLORS.length] ?? "#d7ff52",
      };
    });

    let frame = 0;
    let startTime = 0;
    const draw = (now: number) => {
      if (!startTime) startTime = now;
      const elapsed = now - startTime;
      context.clearRect(0, 0, width, height);
      context.globalAlpha = Math.min(1, Math.max(0, 1 - elapsed / DURATION_MS) * 1.35);

      for (const particle of particles) {
        particle.vy += 0.18;
        particle.vx *= 0.996;
        particle.x += particle.vx;
        particle.y += particle.vy;
        particle.rotation += particle.rotationVelocity;
        const halfWidth = particle.width / 2;
        const halfHeight = particle.height / 2;
        if (particle.x - halfWidth < 0 || particle.x + halfWidth > width) {
          particle.x = Math.max(halfWidth, Math.min(width - halfWidth, particle.x));
          particle.vx *= -0.56;
          particle.rotationVelocity *= 0.84;
        }
        if (particle.y - halfHeight < 0 || particle.y + halfHeight > height) {
          particle.y = Math.max(halfHeight, Math.min(height - halfHeight, particle.y));
          particle.vy *= particle.y + halfHeight > height ? -0.48 : -0.32;
          particle.rotationVelocity *= 0.82;
        }
        context.save();
        context.translate(particle.x, particle.y);
        context.rotate(particle.rotation);
        context.fillStyle = particle.color;
        context.fillRect(-halfWidth, -halfHeight, particle.width, particle.height);
        context.restore();
      }
      if (elapsed < DURATION_MS) frame = window.requestAnimationFrame(draw);
      else onComplete();
    };

    frame = window.requestAnimationFrame(draw);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", resize);
    };
  }, [onComplete]);

  return <canvas ref={canvasRef} className="focus-completion-confetti" aria-hidden="true" />;
}
