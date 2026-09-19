// Render plan.json → plan.md. Must stay in sync on every applied change.
import type { Plan, PlanDay, PlanSegment } from "./store";

const PERIOD_ORDER = ["morning", "lunch", "afternoon", "dinner", "evening"];

function periodLabel(p: string): string {
  return { morning: "Morning", lunch: "Lunch", afternoon: "Afternoon", dinner: "Dinner", evening: "Evening" }[p] || p;
}

function renderSegment(s: PlanSegment): string {
  const time =
    s.start_time || s.end_time ? ` (${s.start_time || ""}${s.end_time ? "–" + s.end_time : ""})` : "";
  let line = `- **${periodLabel(s.period)}** — ${s.title}${time}\n`;
  if (s.details) line += `  ${s.details}\n`;
  const bits: string[] = [];
  if (s.location) bits.push(s.location);
  if (s.tags && s.tags.length) bits.push(s.tags.join(", "));
  if (bits.length) line += `  _${bits.join(" · ")}_\n`;
  return line;
}

function renderDay(d: PlanDay): string {
  let out = `## Day ${d.day_index}`;
  if (d.date) out += ` — ${d.date}`;
  if (d.city) out += ` · ${d.city}`;
  out += "\n\n";
  if (d.hotel) out += `Hotel: ${d.hotel}\n\n`;
  if (d.transit) out += `Transit: ${d.transit.mode} — ${d.transit.detail}\n\n`;
  const segs = [...d.segments].sort(
    (a, b) => PERIOD_ORDER.indexOf(a.period) - PERIOD_ORDER.indexOf(b.period),
  );
  for (const s of segs) out += renderSegment(s);
  if (d.notes) out += `\nNotes: ${d.notes}\n`;
  return out + "\n";
}

export function renderPlanMd(plan: Plan, tripName: string): string {
  let md = `# ${tripName}\n\n`;
  md += `_Version ${plan.version_id} · generated ${plan.created_at} · by ${plan.created_by}_\n\n`;
  if (plan.score) {
    md += `**Score: ${plan.score.composite.toFixed(1)}**`;
    const comps = Object.entries(plan.score.components || {});
    if (comps.length) md += ` (${comps.map(([k, v]) => `${k} ${Number(v).toFixed(1)}`).join(" · ")})`;
    md += "\n\n";
  }
  const days = [...plan.days].sort((a, b) => a.day_index - b.day_index);
  for (const d of days) md += renderDay(d);
  return md;
}
