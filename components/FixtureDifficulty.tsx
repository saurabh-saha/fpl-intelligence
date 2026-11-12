import type { FixtureInfo } from "@/lib/fpl/types";

const COLORS: Record<number, string> = {
  1: "bg-emerald-500 text-white",
  2: "bg-emerald-400 text-emerald-950",
  3: "bg-slate-200 text-slate-800",
  4: "bg-rose-400 text-white",
  5: "bg-rose-700 text-white",
};

export function FdrBadge({ f }: { f: FixtureInfo }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-bold ${COLORS[f.difficulty] ?? COLORS[3]}`} title={`FDR ${f.difficulty}`}>
      {f.oppShort} {f.home ? "(H)" : "(A)"}
    </span>
  );
}

export function Fixtures({ fixtures }: { fixtures: FixtureInfo[] }) {
  if (fixtures.length === 0) return <span className="text-[11px] font-semibold text-slate-400">No fixture</span>;
  return (
    <span className="inline-flex flex-wrap gap-1">
      {fixtures.map((f) => (
        <FdrBadge key={f.fixtureId} f={f} />
      ))}
    </span>
  );
}
