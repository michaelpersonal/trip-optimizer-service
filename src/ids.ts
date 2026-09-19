// ID generators — mirrors the trip-optimizer skill data model.
export function newTripId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || `trip-${Date.now().toString(36)}`;
}

export function newVersionId(n: number): string {
  return `v_${String(n).padStart(3, "0")}`;
}

export function parseVersionId(v: string): number {
  const m = /^v_(\d+)$/.exec(v);
  if (!m) throw new Error(`INVALID_VERSION_ID: ${v}`);
  return parseInt(m[1], 10);
}

export function bumpVersionId(v: string): string {
  return newVersionId(parseVersionId(v) + 1);
}

export function newProposalId(rawRequest?: string): string {
  const unixtime = Math.floor(Date.now() / 1000);
  const slug = (rawRequest || "proposal")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 4)
    .join("_")
    .replace(/[^a-z0-9_]/g, "");
  return `prop_${unixtime}_${slug || "untitled"}`;
}

export function newSegmentId(): string {
  return (
    "seg_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  );
}

export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}
