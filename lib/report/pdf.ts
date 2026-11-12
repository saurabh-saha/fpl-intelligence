import PDFDocument from "pdfkit";
import path from "node:path";
import type { GwReport } from "./build";

const FONT_DIR = path.join(process.cwd(), "node_modules", "dejavu-fonts-ttf", "ttf");
const PURPLE = "#37003c";
const GREY = "#667085";
const W = 842;
const H = 595;
const M = 30;
const CW = W - 2 * M;

export const JSON_BEGIN = "=== BEGIN STRUCTURED DATA (JSON, schema fpl-gw-report/1) ===";
export const JSON_END = "=== END STRUCTURED DATA ===";
export const FOOTER_RE = /FPL Intelligence report \| GW\d+ \| page \d+\/\d+/g;

/** Pretty JSON that keeps small objects on one line, so it is compact but still easy to read and parse. */
export function prettyJson(v: unknown, max = 150, indent = 0): string {
  const flat = JSON.stringify(v);
  if (flat === undefined) return "null";
  if (flat.length <= max || typeof v !== "object" || v === null) return flat;
  const pad = " ".repeat(indent + 1);
  const end = " ".repeat(indent);
  if (Array.isArray(v)) return `[\n${v.map((x) => pad + prettyJson(x, max, indent + 1)).join(",\n")}\n${end}]`;
  return `{\n${Object.entries(v as Record<string, unknown>).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${prettyJson(x, max, indent + 1)}`).join(",\n")}\n${end}}`;
}

export type Col = { label: string; w: number; align?: "left" | "right" | "center" };

/** Layout helpers handed to an optional appendix so extra sections use the same look and pagination. */
export interface PdfHelpers {
  doc: PDFKit.PDFDocument;
  h1: (t: string) => void;
  para: (t: string, o?: { size?: number; color?: string; bold?: boolean; indent?: number }) => void;
  table: (cols: Col[], rows: string[][], opt?: { size?: number; boldFirst?: boolean; rowFill?: (i: number) => string | null }) => void;
  ensure: (h: number) => void;
  width: number;
}

export async function renderReportPdf(report: GwReport & Record<string, unknown>, appendix?: (h: PdfHelpers) => void): Promise<Buffer> {
  const doc = new PDFDocument({
    size: [W, H],
    margin: M,
    bufferPages: true,
    autoFirstPage: true,
    font: path.join(FONT_DIR, "DejaVuSans.ttf"),
    info: {
      Title: report.title,
      Author: "FPL Intelligence",
      Subject: `Gameweek ${report.gameweek.id} squad analysis (${report.squad.formation}, captain ${report.squad.captain})`,
      Keywords: `FPL, Fantasy Premier League, GW${report.gameweek.id}, ${report.schema}, expected points`,
      Creator: "FPL Intelligence",
      Producer: "FPL Intelligence (pdfkit)",
    },
  });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((res) => doc.on("end", () => res(Buffer.concat(chunks))));

  const REG = path.join(FONT_DIR, "DejaVuSans.ttf");
  const BOLD = path.join(FONT_DIR, "DejaVuSans-Bold.ttf");
  const MONO = path.join(FONT_DIR, "DejaVuSansMono.ttf");
  doc.registerFont("reg", REG).registerFont("bold", BOLD).registerFont("mono", MONO);

  const ensure = (h: number) => {
    if (doc.y + h > H - M - 14) doc.addPage();
  };
  const h1 = (t: string) => {
    ensure(40);
    doc.moveDown(0.6).font("bold").fontSize(13).fillColor(PURPLE).text(t, M, doc.y, { width: CW });
    doc.moveTo(M, doc.y + 1).lineTo(W - M, doc.y + 1).strokeColor(PURPLE).lineWidth(0.8).stroke();
    doc.moveDown(0.4).font("reg").fontSize(8).fillColor("#000");
  };
  const para = (t: string, o: { size?: number; color?: string; bold?: boolean; indent?: number } = {}) => {
    doc.font(o.bold ? "bold" : "reg").fontSize(o.size ?? 8.5).fillColor(o.color ?? "#111");
    ensure(doc.heightOfString(t, { width: CW - (o.indent ?? 0) }) + 2);
    doc.text(t, M + (o.indent ?? 0), doc.y, { width: CW - (o.indent ?? 0) });
  };

  function table(cols: Col[], rows: string[][], opt: { size?: number; boldFirst?: boolean; rowFill?: (i: number) => string | null } = {}) {
    const size = opt.size ?? 7.2;
    const header = () => {
      ensure(24);
      const y = doc.y;
      doc.rect(M, y, CW, 14).fill(PURPLE);
      let x = M;
      doc.font("bold").fontSize(size).fillColor("#fff");
      for (const c of cols) { doc.text(c.label, x + 2, y + 3.5, { width: c.w - 4, align: c.align ?? "left", lineBreak: false }); x += c.w; }
      doc.y = y + 15;
    };
    header();
    rows.forEach((r, ri) => {
      doc.font("reg").fontSize(size);
      const hs = r.map((t, i) => doc.heightOfString(String(t), { width: cols[i].w - 4 }));
      const rh = Math.max(...hs) + 4;
      if (doc.y + rh > H - M - 14) { doc.addPage(); header(); }
      const y = doc.y;
      const fill = opt.rowFill?.(ri) ?? (ri % 2 ? "#f6f2f8" : null);
      if (fill) doc.rect(M, y, CW, rh).fill(fill);
      let x = M;
      r.forEach((t, i) => {
        doc.font(i === 0 && opt.boldFirst ? "bold" : "reg").fontSize(size).fillColor("#111");
        doc.text(String(t), x + 2, y + 2, { width: cols[i].w - 4, align: cols[i].align ?? "left" });
        x += cols[i].w;
      });
      doc.y = y + rh;
    });
    doc.moveDown(0.5);
  }

  /* ---------------- page 1: title + summary ---------------- */
  doc.rect(0, 0, W, 62).fill(PURPLE);
  doc.font("bold").fontSize(22).fillColor("#fff").text(report.title, M, 14, { width: CW });
  doc.font("reg").fontSize(9).fillColor("#00ff87").text(`FPL Intelligence | ${report.squadSource}`, M, 42, { width: CW });
  doc.y = 74;
  const sq = report.squad;
  const dl = report.gameweek.deadline ? new Date(report.gameweek.deadline).toUTCString() : "n/a";
  para(`Gameweek ${report.gameweek.id}${report.team ? ` | ${report.team}` : ""} | deadline ${dl} | generated ${report.generatedAt} | optimisation mode: ${report.optimisationMode}`, { bold: true, size: 9 });
  para(`Data: FPL API fetched ${report.dataFreshness.fetchedAt} (source: ${report.dataFreshness.source}${report.dataFreshness.stale ? ", STALE: FPL was unreachable, older data used" : ""}).`, { color: report.dataFreshness.stale ? "#b42318" : GREY });
  para(report.legend, { color: GREY, size: 7.5 });
  doc.moveDown(0.3);

  h1("Squad summary");
  table(
    [{ label: "Formation", w: 80 }, { label: "Captain (x2)", w: 130 }, { label: "Vice-captain", w: 130 }, { label: "Projected points", w: 110 }, { label: "Squad cost", w: 90 }, { label: report.season ? "Bank" : "Remaining", w: 80 }, { label: "Model confidence", w: CW - 620 }],
    [[sq.formation, sq.captain, sq.viceCaptain, `${sq.projectedPoints.toFixed(1)} xPts`, `£${sq.totalCostM.toFixed(1)}m`, sq.bankM === null ? "n/a" : `£${sq.bankM.toFixed(1)}m`, `${(sq.modelConfidence.overall * 100).toFixed(0)}% overall (XI ${(sq.modelConfidence.startingXI * 100).toFixed(0)}%); ${sq.modelConfidence.counts.high} high / ${sq.modelConfidence.counts.medium} medium / ${sq.modelConfidence.counts.low} low`]],
    { size: 8 },
  );
  para(sq.projectedPointsNote, { color: GREY, size: 7.5 });
  if (report.userEditsVsGeneratedSquad) para(`User edits vs the generated squad: removed ${report.userEditsVsGeneratedSquad.removed.join(", ") || "none"}; added ${report.userEditsVsGeneratedSquad.added.join(", ") || "none"}.`, { bold: true, size: 8 });
  if (report.season) {
    const s = report.season;
    para(`Free transfers: ${s.freeTransfersAvailable}${s.freeTransfersAreDerived ? " (derived from FPL history; FPL does not expose this)" : ""} | after plan: ${s.freeTransfersAfterPlan} | chip planned: ${s.chipPlannedThisGameweek ?? "none"} | chips available: ${s.chipsAvailable.join(", ") || "none"} | hit: ${s.proposedPlan.hitCost ? `-${s.proposedPlan.hitCost}` : "none"}`, { size: 8.5 });
  }

  h1("How to use this report for an independent review");
  para("This PDF contains selectable text and a complete machine-readable JSON copy (final pages, and attached to the PDF as a file). Upload it to an AI assistant and ask, for example:", { size: 8 });
  para("“You are an experienced FPL manager. Using only this report, review the squad, starting XI, captain, bench order and any transfer or chip advice for this gameweek. Point out risks, anything the model may have missed, and what you would change and why. Do not invent statistics that are not in the report.”", { size: 8, color: PURPLE, indent: 12 });
  report.reviewerGuide.forEach((g) => para(`• ${g}`, { size: 8, indent: 12 }));

  /* ---------------- squad tables ---------------- */
  const ps = report.players;
  const row = (p: (typeof ps)[number]) => [
    p.role === "starting" ? String(p.slot) : `B${p.benchOrder}`,
    p.position,
    `${p.name}${p.isCaptain ? " (C)" : p.isViceCaptain ? " (V)" : ""}`,
    p.club ?? "",
    p.priceM.toFixed(1),
    `${p.ownershipPct}%`,
    p.projection.xPts.toFixed(2),
    `${p.projection.confidence} (${Math.round(p.projection.confidenceScore * 100)})`,
    `${Math.round(p.projection.startProbability * 100)}%`,
    String(p.projection.expectedMinutes),
    p.projection.fixtures.length ? p.projection.fixtures.map((f) => `${f.opponent}(${f.home ? "H" : "A"}) FDR${f.fdr}`).join(", ") : "No fixture",
    `${p.season.minutes}`,
    `${p.season.goals}/${p.season.assists}`,
    `${p.season.xG}/${p.season.xA}`,
    String(p.season.form),
    p.status === "a" && !p.news ? "fit" : `${p.status}${p.news ? `: ${p.news}` : ""}`,
  ];
  const cols: Col[] = [
    { label: "#", w: 22 }, { label: "Pos", w: 28 }, { label: "Player", w: 88 }, { label: "Club", w: 30 }, { label: "£m", w: 28, align: "right" }, { label: "Own", w: 32, align: "right" },
    { label: "xPts", w: 32, align: "right" }, { label: "Confidence", w: 58 }, { label: "Start", w: 30, align: "right" }, { label: "xMin", w: 28, align: "right" }, { label: "GW fixture(s)", w: 98 },
    { label: "Mins", w: 30, align: "right" }, { label: "G/A", w: 28, align: "right" }, { label: "xG/xA", w: 40, align: "right" }, { label: "Form", w: 28, align: "right" }, { label: "Status", w: CW - 600 },
  ];
  doc.addPage();
  h1(`Starting XI (${sq.formation}) - ${ps.filter((p) => p.role === "starting").length} players`);
  table(cols, ps.filter((p) => p.role === "starting").map(row), { rowFill: (i) => (ps[i].isCaptain ? "#e6fff3" : ps[i].isViceCaptain ? "#f1fbff" : i % 2 ? "#f6f2f8" : null) });
  h1("Bench (in substitution order)");
  table(cols, ps.filter((p) => p.role === "bench").map(row));
  para("Season columns (Mins, G/A, xG/xA, Form, Status, Own, price) are FACT from FPL. xPts, Confidence, Start, xMin are MODEL predictions for this gameweek.", { size: 7.5, color: GREY });

  /* ---------------- breakdown ---------------- */
  h1("Expected-points breakdown (MODEL)");
  const b = (n: number) => (n === 0 ? "0" : n.toFixed(2));
  table(
    [{ label: "Player", w: 110 }, { label: "Role", w: 50 }, { label: "Appear.", w: 52, align: "right" }, { label: "Goals", w: 52, align: "right" }, { label: "Assists", w: 52, align: "right" }, { label: "Clean sheet", w: 62, align: "right" }, { label: "Goals conc.", w: 62, align: "right" }, { label: "Saves", w: 50, align: "right" }, { label: "Def. contrib.", w: 66, align: "right" }, { label: "Bonus", w: 50, align: "right" }, { label: "Cards", w: 50, align: "right" }, { label: "Form tilt", w: 52, align: "right" }, { label: "Total xPts", w: CW - 708, align: "right" }],
    ps.map((p) => { const c = p.projection.breakdown; return [p.name, p.role === "starting" ? "XI" : `bench ${p.benchOrder}`, b(c.appearance), b(c.goals), b(c.assists), b(c.cleanSheet), b(c.goalsConceded), b(c.saves), b(c.defContrib), b(c.bonus), b(c.cards), b(c.formAdj), p.projection.xPts.toFixed(2)]; }),
  );

  /* ---------------- fixtures ---------------- */
  h1("Fixtures and expected points: next five gameweeks");
  const gws = ps[0].upcomingFiveGws.map((u) => u.gw);
  table(
    [{ label: "Player", w: 100 }, ...gws.map(() => ({ label: "", w: (CW - 100) / gws.length }))].map((c, i) => (i === 0 ? c : { ...c, label: `GW${gws[i - 1]} fixture, xPts` })),
    ps.map((p) => [p.name, ...p.upcomingFiveGws.map((u) => `${u.fixtures.length ? u.fixtures.join(" + ") : "blank"}, ${u.xPts.toFixed(1)}`)]),
    { size: 7 },
  );

  /* ---------------- reasoning ---------------- */
  h1("Why each player is in the squad, and warnings");
  for (const p of ps) {
    ensure(46);
    doc.font("bold").fontSize(8.5).fillColor(PURPLE).text(`${p.name} (${p.position}, ${p.club}, £${p.priceM.toFixed(1)}m, ${p.role === "starting" ? "XI" : `bench ${p.benchOrder}`}${p.isCaptain ? ", CAPTAIN" : p.isViceCaptain ? ", VICE-CAPTAIN" : ""}) - ${p.projection.xPts.toFixed(2)} xPts, ${p.projection.confidence} confidence`, M, doc.y, { width: CW });
    doc.font("reg").fontSize(7.8).fillColor("#111");
    p.whySelected.forEach((r) => doc.text(`+ ${r}`, M + 10, doc.y, { width: CW - 10 }));
    p.warnings.forEach((w) => doc.fillColor("#b54708").text(`! ${w}`, M + 10, doc.y, { width: CW - 10 }));
    doc.fillColor("#111").moveDown(0.25);
  }

  /* ---------------- my team ---------------- */
  if (report.season) {
    const s = report.season;
    h1("Actual squad vs proposed plan (My Team)");
    para(s.actualSquad.note + `. Projected with no changes: ${s.actualSquad.projectedPointsWithNoChanges.toFixed(1)} xPts.`, { bold: true, size: 8.5 });
    table(
      [{ label: "Player", w: 130 }, { label: "Club", w: 50 }, { label: "Pos", w: 40 }, { label: "Bought £m", w: 70, align: "right" }, { label: "Selling £m", w: 70, align: "right" }],
      s.actualSquad.players.map((p) => [p.name, p.club ?? "", p.position, p.purchasePriceM.toFixed(1), p.sellingPriceM.toFixed(1)]),
    );
    para(`Proposed plan: ${s.proposedPlan.transfers.length} transfer(s), hit -${s.proposedPlan.hitCost}, ${s.proposedPlan.projectedPoints.toFixed(1)} xPts (${s.proposedPlan.projectedPointsAfterHit.toFixed(1)} after hit). Plan legal: ${s.proposedPlan.valid ? "yes" : "NO: " + s.proposedPlan.errors.join(" ")}`, { bold: true, size: 8.5 });
    if (s.proposedPlan.transfers.length) {
      table([{ label: "Sell", w: 160 }, { label: "Sell price £m", w: 90, align: "right" }, { label: "Buy", w: 160 }, { label: "Buy price £m", w: 90, align: "right" }], s.proposedPlan.transfers.map((t) => [t.sell, t.sellPriceM.toFixed(1), t.buy, t.buyPriceM.toFixed(1)]));
    }
  }

  /* ---------------- transfers / replacements ---------------- */
  const tr = report.transferRecommendations as any;
  h1(report.season ? "Transfer recommendations (MODEL)" : "Replacement shortlist (Team Builder)");
  if (tr?.decision) {
    para(`Decision: ${tr.headline} [${tr.decision}]. ${tr.reason}`, { bold: true, size: 8.5 });
    para(tr.note, { size: 7.5, color: GREY });
    table(
      [{ label: "Option", w: 210 }, { label: "This GW", w: 70, align: "right" }, { label: "5-GW gain", w: 80, align: "right" }, { label: "Hit", w: 50, align: "right" }, { label: "Net", w: 60, align: "right" }, { label: "FT after", w: 60, align: "right" }, { label: "Moves", w: CW - 530 }],
      tr.options.map((o: any) => [o.label + (o.transfers === tr.recommendedTransfers ? "  [recommended]" : ""), o.gainThisGw.toFixed(1), o.gainFiveGws.toFixed(1), o.hitCost ? `-${o.hitCost}` : "0", o.net.toFixed(1), String(o.freeTransfersAfter), o.moves.map((m: any) => `${m.sell} -> ${m.buy}`).join("; ") || "none"]),
    );
    for (const o of tr.options.filter((x: any) => x.transfers === tr.recommendedTransfers)) for (const m of o.moves) para(`${m.sell} -> ${m.buy}: ${m.explanation} (net ${m.net.toFixed(1)}, deduction ${m.deduction})`, { size: 7.8, indent: 8 });
    if (tr.sellShortlist?.length) {
      para("Sell shortlist (weakest-value players and best alternatives):", { bold: true, size: 8.5 });
      tr.sellShortlist.forEach((c: any) => para(`${c.sell} (sell £${c.sellPriceM.toFixed(1)}m, ${c.reason}) -> ${c.alternatives.map((a: any) => `${a.buy} (${a.netFiveGws >= 0 ? "+" : ""}${a.netFiveGws.toFixed(1)})`).join(", ") || "no better legal option"}`, { size: 7.8, indent: 8 }));
    }
  } else if (tr?.replacementShortlist) {
    para(tr.note, { size: 7.5, color: GREY });
    table(
      [{ label: "Player", w: 130 }, { label: "Best legal replacements (xPts, £m, squad change)", w: CW - 130 }],
      Object.entries(tr.replacementShortlist).map(([n, alts]: any) => [n, alts.map((a: any) => `${a.player} ${a.xPts.toFixed(1)}xPts £${a.priceM.toFixed(1)}m (${a.squadPointsChange >= 0 ? "+" : ""}${a.squadPointsChange.toFixed(1)})`).join("  |  ") || "none"]),
      { size: 7 },
    );
  }

  if (report.chipStrategy) {
    h1("Chip strategy (MODEL)");
    table(
      [{ label: "Chip", w: 90 }, { label: "Available", w: 60 }, { label: "Verdict", w: 100 }, { label: "Gain now", w: 60, align: "right" }, { label: "Best GW", w: 80 }, { label: "Advice", w: CW - 390 }],
      report.chipStrategy.map((c) => [c.chip, c.available ? "yes" : "no", c.verdict, c.gainNow.toFixed(1), c.bestGameweek ? `GW${c.bestGameweek.gw} (+${c.bestGameweek.gain.toFixed(1)})` : "-", c.advice]),
      { size: 7 },
    );
  }

  /* ---------------- methodology ---------------- */
  h1("Model, confidence and known limitations");
  para(report.model.description, { size: 8 });
  para(report.model.confidence, { size: 8 });
  if (report.model.backtest) {
    const bt = report.model.backtest;
    para(`Backtest (${bt.gameweeks}, ${bt.sample} player-gameweeks): model MAE ${bt.modelMae} vs points-per-game baseline ${bt.baselineMae}; bias ${bt.modelBias}; captain avg ${bt.captainAvgPoints} vs ${bt.baselineCaptainAvgPoints}. ${bt.caveat}`, { size: 8 });
  }
  report.model.limitations.forEach((l) => para(`• ${l}`, { size: 8, indent: 8 }));

  if (appendix) {
    doc.addPage();
    appendix({ doc, h1, para, table, ensure, width: CW });
  }

  /* ---------------- structured data ---------------- */
  doc.addPage();
  h1("Structured data (machine-readable)");
  para("The complete report as JSON follows (also attached to this PDF as a file). Line breaks inside long strings are layout wrapping only.", { size: 7.5, color: GREY });
  doc.font("mono").fontSize(6.4).fillColor("#000");
  const lines = [JSON_BEGIN, ...prettyJson(report).split("\n"), JSON_END];
  for (const ln of lines) {
    const hh = doc.heightOfString(ln || " ", { width: CW });
    if (doc.y + hh > H - M - 14) doc.addPage().font("mono").fontSize(6.4).fillColor("#000");
    doc.text(ln || " ", M, doc.y, { width: CW });
  }

  // attach the exact JSON so tools that read PDF attachments get it losslessly
  doc.file(Buffer.from(JSON.stringify(report, null, 2), "utf8"), { name: `fpl-gw${report.gameweek.id}-report.json`, type: "application/json", description: "Structured copy of this report (schema fpl-gw-report/1)" });

  // footers (page numbers) on every page
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0; // footer sits inside the bottom margin; stops pdfkit from adding a page
    doc.font("reg").fontSize(7).fillColor(GREY).text(`FPL Intelligence report | GW${report.gameweek.id} | page ${i + 1}/${range.count}`, M, H - 22, { width: CW, align: "center", lineBreak: false });
  }
  doc.end();
  return done;
}
