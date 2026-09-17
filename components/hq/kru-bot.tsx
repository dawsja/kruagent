"use client";

import { useEffect, useState, type CSSProperties } from "react";

/**
 * KruBot — Kru bot: rounded flame mascot with an animated face.
 * Pure React + SVG + CSS, no deps.
 *
 * Props:
 *  color       base color
 *  size        px (default 200)
 *  expression  "happy" | "wink" | "surprised" | "sleepy" | "excited"
 *  greet       play hello bounce on mount (default true)
 *  tilt        deg rotation of the body (default 0)
 */
export type KruBotExpression = "happy" | "wink" | "surprised" | "sleepy" | "excited";

export type KruBotProps = {
  color?: string;
  size?: number;
  expression?: KruBotExpression;
  greet?: boolean;
  tilt?: number;
  label?: string;
};

export function KruBot({
  color = "#1DB954",
  size = 200,
  expression = "happy",
  greet = true,
  tilt = 0,
  label = "Kru bot saying hello",
}: KruBotProps) {
  const [blink, setBlink] = useState(false);
  const [wave, setWave] = useState(greet);
  const [look, setLook] = useState({ x: 0, y: 0 });

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        setBlink(true);
        setTimeout(() => setBlink(false), 150);
        loop();
      }, 2400 + Math.random() * 2800);
    };
    loop();
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      t = setTimeout(() => {
        setLook({ x: (Math.random() - 0.5) * 4, y: (Math.random() - 0.5) * 3 });
        setTimeout(() => setLook({ x: 0, y: 0 }), 900);
        loop();
      }, 3500 + Math.random() * 4000);
    };
    loop();
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!wave) return;
    const t = setTimeout(() => setWave(false), 1300);
    return () => clearTimeout(t);
  }, [wave]);

  const exp = wave ? "excited" : expression;
  const eyeR = exp === "surprised" ? 5.5 : 4.5;

  const FLAME =
    "M44 8 C30 22 20 36 20 54 C20 74 34 90 52 90 C72 90 84 74 82 54 C80 42 72 36 68 28 C66 36 60 42 56 40 C62 32 56 18 44 8 Z";

  // A plain function, not a component: the eyes are drawn inline each render.
  const eye = ({ cx, cy, closed, lid }: { cx: number; cy: number; closed: boolean; lid: boolean }) =>
    closed ? (
      <path d={`M${cx - 5} ${cy} q5 3 10 0`} stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
    ) : lid ? (
      <path d={`M${cx - 5} ${cy} q5 -4 10 0`} stroke="#fff" strokeWidth="3" fill="none" strokeLinecap="round" />
    ) : exp === "excited" ? (
      <ellipse cx={cx} cy={cy} rx="4" ry="5.5" fill="#fff" />
    ) : (
      <circle cx={cx} cy={cy} r={eyeR} fill="#fff" />
    );

  return (
    <div
      className={`hb${wave ? " kb-wave" : ""}`}
      style={{ width: size, height: size, "--tilt": `${tilt}deg` } as CSSProperties}
      onClick={() => setWave(true)}
      role="img"
      aria-label={label}
    >
      <svg viewBox="0 0 100 100" className="kb-svg">
        <g className="kb-body">
          <g className="kb-shape">
            <path d={FLAME} fill={color} stroke={color} strokeWidth="5" strokeLinejoin="round" />
          </g>

          <g className="kb-face" style={{ transform: `translate(${look.x}px, ${look.y}px)` }}>
            <g className={`kb-eye${blink ? " kb-blink" : ""}`}>
              {eye({ cx: 43, cy: 58, closed: exp === "sleepy", lid: false })}
            </g>
            <g className={`kb-eye${blink ? " kb-blink" : ""}`}>
              {eye({ cx: 61, cy: 58, closed: exp === "sleepy", lid: exp === "wink" })}
            </g>
            <g className="kb-mouth">
              {exp === "surprised" ? (
                <ellipse cx="52" cy="71" rx="2.6" ry="3.4" fill="#fff" />
              ) : (
                <path
                  d={exp === "excited" ? "M45 69 q7 7 14 0" : "M47 69 q5 3 10 0"}
                  stroke="#fff" strokeWidth="2.6" fill="none" strokeLinecap="round"
                />
              )}
            </g>
          </g>
        </g>
      </svg>

      <style>{`
        .hb { display:inline-block; cursor:pointer; user-select:none; }
        .kb-svg { width:100%; height:100%; overflow:visible; }
        .kb-body { transform-box:fill-box; transform-origin:50% 90%; animation: kb-flicker 2.6s ease-in-out infinite; }
        .kb-wave .kb-body { animation: kb-hello 1.3s cubic-bezier(.34,1.56,.64,1) 1; }
        .kb-shape { transform-box:fill-box; transform-origin:50% 90%; transform: rotate(var(--tilt)); }
        .kb-face { transition: transform .5s cubic-bezier(.2,.8,.2,1); }
        .kb-eye { transform-box:fill-box; transform-origin:center; }
        .kb-blink { animation: kb-blink .15s ease-in-out; }
        .kb-mouth path { transition: d .3s ease; }

        @keyframes kb-flicker { 0%,100%{transform:scale(1,1) rotate(0)} 30%{transform:scale(.98,1.03) rotate(-1.5deg)} 65%{transform:scale(1.02,.98) rotate(1.5deg)} }
        @keyframes kb-hello {
          0%{transform:scale(1) rotate(0)}
          25%{transform:scale(1.12,.9) rotate(-8deg) translateY(2px)}
          50%{transform:scale(.94,1.08) rotate(8deg) translateY(-6px)}
          75%{transform:scale(1.04,.98) rotate(-3deg)}
          100%{transform:scale(1) rotate(0)}
        }
        @keyframes kb-blink { 0%,100%{transform:scaleY(1)} 50%{transform:scaleY(.08)} }
        @media (prefers-reduced-motion: reduce) { .kb-body,.kb-blink{animation:none!important} }
      `}</style>
    </div>
  );
}

export default KruBot;
