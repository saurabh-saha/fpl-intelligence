"use client";
import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { api, fmtGbp, type Meta, type PlayerView } from "@/lib/client";
import { Photo } from "@/components/Photo";
import { Fixtures } from "@/components/FixtureDifficulty";
import { PlayerComparison } from "@/components/PlayerComparison";
import { GameweekSelector } from "@/components/GameweekSelector";

const SORTS = [["ep", "xPts"], ["goals", "Goals"], ["assists", "Assists"], ["xG", "xG"], ["xA", "xA"], ["minutes", "Minutes"], ["form", "Form"], ["cost", "Price"], ["ownership", "Owned"], ["totalPoints", "Points"]] as const;

export default function PlayersPage() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [gw, setGw] = useState(0);
  const [q, setQ] = useState("");
  const [pos, setPos] = useState("");
  const [team, setTeam] = useState("");
  const [sort, setSort] = useState("ep");
  const [dir, setDir] = useState<"asc" | "desc">("desc");
  const [rows, setRows] = useState<PlayerView[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [picked, setPicked] = useState<PlayerView[]>([]);
  const [showCmp, setShowCmp] = useState(false);

  useEffect(() => { api<Meta>("/api/bootstrap").then((m) => { setMeta(m); setGw(m.nextGw); }); }, []);
  useEffect(() => {
    if (!gw) return;
    const t = setTimeout(() => {
      setLoading(true);
      const qs = new URLSearchParams({ gw: String(gw), sort, dir, limit: "60" });
      if (q) qs.set("q", q);
      if (pos) qs.set("pos", pos);
      if (team) qs.set("team", team);
      api<{ players: PlayerView[]; total: number }>(`/api/players?${qs}`).then((r) => { setRows(r.players); setTotal(r.total); }).finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(t);
  }, [gw, q, pos, team, sort, dir]);

  const toggle = (p: PlayerView) => setPicked((c) => (c.some((x) => x.id === p.id) ? c.filter((x) => x.id !== p.id) : [...c, p].slice(-3)));
  const th = (key: string, label: string) => (
    <button onClick={() => (sort === key ? setDir(dir === "desc" ? "asc" : "desc") : (setSort(key), setDir("desc")))} className={`font-bold ${sort === key ? "text-fpl-purple" : "text-slate-500"}`}>{label}{sort === key ? (dir === "desc" ? " ↓" : " ↑") : ""}</button>
  );
  const chips = useMemo(() => ["", "GKP", "DEF", "MID", "FWD"], []);

  return (
    <div className="space-y-4">
      <div className="card space-y-3 p-4">
        <h1 className="text-2xl font-black text-fpl-purple">Player explorer</h1>
        {meta && <GameweekSelector meta={meta} value={gw} onChange={setGw} />}
        <div className="flex flex-wrap gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name" className="min-w-[200px] flex-1 rounded-xl border px-3 py-2" data-testid="search" />
          <select value={team} onChange={(e) => setTeam(e.target.value)} className="rounded-xl border px-3 py-2" data-testid="team-filter">
            <option value="">All clubs</option>
            {meta?.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <div className="flex gap-1">{chips.map((c) => <button key={c} onClick={() => setPos(c)} data-testid={`pos-${c || "ALL"}`} className={`rounded-full px-3 py-2 text-xs font-bold ${pos === c ? "bg-fpl-purple text-white" : "bg-fpl-bg text-fpl-purple"}`}>{c || "All"}</button>)}</div>
          <select value={sort} onChange={(e) => { setSort(e.target.value); setDir("desc"); }} className="rounded-xl border px-3 py-2" data-testid="sort">{SORTS.map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}</select>
        </div>
        <div className="flex items-center justify-between text-xs text-slate-500"><span>{loading ? "Loading…" : `${total} players`} · select up to 3 to compare</span>{picked.length >= 2 && <button onClick={() => setShowCmp(true)} className="rounded-full bg-fpl-green px-3 py-1.5 font-extrabold text-fpl-purple" data-testid="compare-btn">Compare {picked.length}</button>}</div>
      </div>

      <div className="card overflow-x-auto">
        <table className="w-full min-w-[760px] text-sm" data-testid="players-table">
          <thead><tr className="border-b text-left text-xs"><th className="p-3" /><th className="p-3">Player</th><th className="p-3">{th("cost", "£")}</th><th className="p-3">{th("ep", "xPts")}</th><th className="p-3">{th("goals", "G")}</th><th className="p-3">{th("assists", "A")}</th><th className="p-3">{th("xG", "xG")}</th><th className="p-3">{th("xA", "xA")}</th><th className="p-3">{th("minutes", "Min")}</th><th className="p-3">{th("form", "Form")}</th><th className="p-3">{th("ownership", "Own%")}</th><th className="p-3">Fixture</th></tr></thead>
          <tbody>
            {rows.map((p) => (
              <tr key={p.id} className="border-b last:border-0 hover:bg-fpl-bg/60" data-testid="player-row">
                <td className="p-3"><input type="checkbox" checked={picked.some((x) => x.id === p.id)} onChange={() => toggle(p)} aria-label={`Compare ${p.name}`} className="h-4 w-4 accent-fpl-purple" /></td>
                <td className="p-3"><Link href={`/player/${p.id}?gw=${gw}`} className="flex items-center gap-2"><Photo src={p.photoUrl} name={p.name} pos={p.pos} size={36} /><span><span className="block font-extrabold text-fpl-purple">{p.name}</span><span className="text-xs text-slate-500">{p.team} · {p.pos}{p.availability < 1 ? " · ⚠" : ""}</span></span></Link></td>
                <td className="p-3 tabular-nums">{fmtGbp(p.cost)}</td>
                <td className="p-3 font-black tabular-nums text-fpl-purple">{p.ep.toFixed(1)}</td>
                <td className="p-3 tabular-nums">{p.goals}</td><td className="p-3 tabular-nums">{p.assists}</td><td className="p-3 tabular-nums">{p.xG}</td><td className="p-3 tabular-nums">{p.xA}</td><td className="p-3 tabular-nums">{p.minutes}</td><td className="p-3 tabular-nums">{p.form}</td><td className="p-3 tabular-nums">{p.ownership}</td>
                <td className="p-3"><Fixtures fixtures={p.fixtures} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {showCmp && <PlayerComparison players={picked} onClose={() => setShowCmp(false)} />}
    </div>
  );
}
