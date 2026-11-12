"use client";
import { useEffect, useState } from "react";

export function Countdown({ to }: { to: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (now === null) return <span>--</span>;
  const ms = new Date(to).getTime() - now;
  if (ms <= 0) return <span>Deadline passed</span>;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const parts = [d ? `${d}d` : null, `${h}h`, `${m}m`, `${s % 60}s`].filter(Boolean);
  return <span className="tabular-nums">{parts.join(" ")}</span>;
}
