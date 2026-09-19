import * as fs from "node:fs";
import * as path from "node:path";
import * as YAML from "yaml";

// ---------------------------------------------------------------------------
// Types (subset of the skill's data model — the shapes the API owns)
// ---------------------------------------------------------------------------

export interface ScoreBlock {
  composite: number;
  components: Record<string, number>;
}

export interface PlanSegment {
  id: string;
  type: "activity" | "meal" | "transit" | "free_time" | "hotel";
  period: "morning" | "lunch" | "afternoon" | "dinner" | "evening";
  title: string;
  details?: string;
  /** The story or reason this stop earns its place. */
  why?: string;
  /** The famous nearby thing NOT worth it, and why. */
  skip_note?: string;
  /** Labeled alternatives, e.g. [{label:"A", text:"Rainy-day swap: ..."}]. */
  alternatives?: { label: string; text: string }[];
  location?: string;
  start_time?: string;
  end_time?: string;
  tags?: string[];
}

export interface PlanDay {
  day_index: number;
  date?: string;
  city?: string;
  hotel?: string;
  /** Day subtitle, e.g. "外滩、弄堂与梧桐树". */
  theme?: string;
  /** 1–2 sentences connecting this day to the previous one. */
  transition?: string;
  transit?: { mode: string; detail: string };
  segments: PlanSegment[];
  notes?: string;
}

export interface Plan {
  version_id: string;
  parent_version_id: string | null;
  created_at: string;
  created_by: string;
  score?: ScoreBlock;
  /** Pre-trip prep sections rendered before the days. */
  logistics?: { heading: string; body: string }[];
  days: PlanDay[];
}

export type ProposalStatus =
  | "pending"
  | "applied"
  | "rejected"
  | "needs_clarification";

export interface Proposal {
  proposal_id: string;
  trip_id: string;
  base_version_id: string;
  status: ProposalStatus;
  requested_by?: string;
  requested_at: string;
  request_language?: string;
  raw_request?: string;
  intent?: "direct_override" | "scoped_reoptimize" | "structural_change";
  scope?: Record<string, unknown>;
  candidate_plan: Plan | null;
  impact_summary?: {
    changed_segments?: string[];
    score_before?: number;
    score_after?: number;
    score_delta?: number;
    tradeoffs?: string[];
  } | null;
  explanation?: Record<string, string>;
  clarification?: {
    question: string;
    options: { day_index?: number; segment_id?: string; title: string }[];
  };
  rejection_reason?: string;
  applied_at?: string;
  resulting_version_id?: string;
}

export interface TripSummary {
  trip_id: string;
  name: string;
  created_at: string;
  status: "active" | "archived";
  current_version_id: string;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public statusCode = 400,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// File-backed store. Layout:
//   <dataDir>/trips.json
//   <dataDir>/trips/<trip_id>/{plan.json,constraints.yaml,rubrics.yaml,
//                             activities.json,plan.md,proposals/<id>.json,
//                             run-log.tsv}
//   <dataDir>/profile.json
// ---------------------------------------------------------------------------

const RUN_LOG_HEADER =
  "iteration\ttimestamp\tmutation_type\tdescription\tscore_before\tscore_after\tdelta\tkept\n";

export class Store {
  constructor(public dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
  }

  private registryPath() {
    return path.join(this.dataDir, "trips.json");
  }

  private tripDir(tripId: string) {
    return path.join(this.dataDir, "trips", tripId);
  }

  // -- registry -----------------------------------------------------------

  readRegistry(): { trips: Record<string, TripSummary>; default_trip: string | null } {
    const p = this.registryPath();
    if (!fs.existsSync(p)) return { trips: {}, default_trip: null };
    return JSON.parse(fs.readFileSync(p, "utf8"));
  }

  writeRegistry(reg: { trips: Record<string, TripSummary>; default_trip: string | null }) {
    this.writeFileAtomic(this.registryPath(), JSON.stringify(reg, null, 2) + "\n");
  }

  requireTrip(tripId: string): TripSummary {
    const reg = this.readRegistry();
    const t = reg.trips[tripId];
    if (!t) throw new ApiError("TRIP_NOT_FOUND", `Unknown trip: ${tripId}`, 404);
    if (!fs.existsSync(this.tripDir(tripId)))
      throw new ApiError("TRIP_NOT_FOUND", `Trip data missing: ${tripId}`, 404);
    return t;
  }

  // -- generic file helpers -------------------------------------------------

  private writeFileAtomic(p: string, content: string) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const tmp = `${p}.tmp.${process.pid}`;
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, p);
  }

  readJson<T>(p: string): T {
    return JSON.parse(fs.readFileSync(p, "utf8")) as T;
  }

  writeJson(p: string, v: unknown) {
    this.writeFileAtomic(p, JSON.stringify(v, null, 2) + "\n");
  }

  readYamlDoc(p: string): unknown {
    return YAML.parse(fs.readFileSync(p, "utf8"));
  }

  writeYamlDoc(p: string, v: unknown) {
    this.writeFileAtomic(p, YAML.stringify(v));
  }

  // -- plan -----------------------------------------------------------------

  planPath(tripId: string) {
    return path.join(this.tripDir(tripId), "plan.json");
  }

  readPlan(tripId: string): Plan {
    this.requireTrip(tripId);
    return this.readJson<Plan>(this.planPath(tripId));
  }

  writePlan(tripId: string, plan: Plan) {
    this.requireTrip(tripId);
    this.writeJson(this.planPath(tripId), plan);
    const reg = this.readRegistry();
    reg.trips[tripId].current_version_id = plan.version_id;
    this.writeRegistry(reg);
  }

  // -- doc files (constraints.yaml, rubrics.yaml, activities.json) ----------

  docPath(tripId: string, name: string) {
    return path.join(this.tripDir(tripId), name);
  }

  readDoc(tripId: string, name: "constraints.yaml" | "rubrics.yaml" | "activities.json"): unknown | null {
    this.requireTrip(tripId);
    const p = this.docPath(tripId, name);
    if (!fs.existsSync(p)) return null;
    return name.endsWith(".yaml") ? this.readYamlDoc(p) : this.readJson(p);
  }

  writeDoc(tripId: string, name: "constraints.yaml" | "rubrics.yaml" | "activities.json", v: unknown) {
    this.requireTrip(tripId);
    const p = this.docPath(tripId, name);
    if (name.endsWith(".yaml")) this.writeYamlDoc(p, v);
    else this.writeJson(p, v);
  }

  // -- proposals ------------------------------------------------------------

  proposalsDir(tripId: string) {
    return path.join(this.tripDir(tripId), "proposals");
  }

  proposalPath(tripId: string, proposalId: string) {
    return path.join(this.proposalsDir(tripId), `${proposalId}.json`);
  }

  listProposals(tripId: string, status?: ProposalStatus): Proposal[] {
    this.requireTrip(tripId);
    const dir = this.proposalsDir(tripId);
    if (!fs.existsSync(dir)) return [];
    const out: Proposal[] = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      const p = this.readJson<Proposal>(path.join(dir, f));
      if (!status || p.status === status) out.push(p);
    }
    out.sort((a, b) => (a.requested_at < b.requested_at ? 1 : -1));
    return out;
  }

  findProposal(proposalId: string): { tripId: string; proposal: Proposal } {
    const reg = this.readRegistry();
    for (const tripId of Object.keys(reg.trips)) {
      const p = this.proposalPath(tripId, proposalId);
      if (fs.existsSync(p)) return { tripId, proposal: this.readJson<Proposal>(p) };
    }
    throw new ApiError("PROPOSAL_NOT_FOUND", `Unknown proposal: ${proposalId}`, 404);
  }

  writeProposal(tripId: string, p: Proposal) {
    this.writeJson(this.proposalPath(tripId, p.proposal_id), p);
  }

  // -- run log (append-only) -------------------------------------------------

  private runLogPath(tripId: string) {
    return path.join(this.tripDir(tripId), "run-log.tsv");
  }

  appendRunLog(
    tripId: string,
    row: {
      mutation_type: string;
      description: string;
      score_before?: number;
      score_after?: number;
      kept: boolean;
    },
  ): number {
    this.requireTrip(tripId);
    const p = this.runLogPath(tripId);
    let iteration = 1;
    if (fs.existsSync(p)) {
      const lines = fs.readFileSync(p, "utf8").trim().split("\n");
      iteration = lines.length; // header + (iteration) rows → next = lines.length
    } else {
      fs.writeFileSync(p, RUN_LOG_HEADER);
    }
    const delta =
      row.score_before !== undefined && row.score_after !== undefined
        ? +(row.score_after - row.score_before).toFixed(2)
        : "";
    const line = [
      iteration,
      new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      row.mutation_type,
      (row.description || "").replace(/\t|\n/g, " "),
      row.score_before ?? "",
      row.score_after ?? "",
      delta,
      row.kept ? "yes" : "no",
    ].join("\t");
    fs.appendFileSync(p, line + "\n");
    return iteration;
  }

  readRunLog(tripId: string): string {
    this.requireTrip(tripId);
    const p = this.runLogPath(tripId);
    return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : RUN_LOG_HEADER;
  }

  // -- profile ---------------------------------------------------------------

  profilePath() {
    return path.join(this.dataDir, "profile.json");
  }

  readProfile(): unknown {
    const p = this.profilePath();
    return fs.existsSync(p) ? this.readJson(p) : {};
  }

  writeProfile(v: unknown) {
    this.writeJson(this.profilePath(), v);
  }
}
