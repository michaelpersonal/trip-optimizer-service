// Trip Optimizer deterministic state API.
// The agent does ALL LLM reasoning (proposals, scoring, research, Q&A).
// This service owns: versioning, proposal lifecycle, rendering, run logs.
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError, Plan, Proposal, ProposalStatus, Store } from "./store";
import { bumpVersionId, newProposalId, newTripId, newVersionId, parseVersionId, utcNow } from "./ids";
import { renderPlanMd } from "./render";

const PORT = parseInt(process.env.PORT || "8787", 10);
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), "data");

// -- dumb key auth ------------------------------------------------------------
// Single shared key. Set TRIP_OPTIMIZER_API_KEY env; if unset, a random key is
// generated at boot and printed (the service is never accidentally open).
let API_KEY = process.env.TRIP_OPTIMIZER_API_KEY;
if (!API_KEY) {
  API_KEY = crypto.randomBytes(24).toString("hex");
  console.log(`[auth] TRIP_OPTIMIZER_API_KEY unset — generated one-time key: ${API_KEY}`);
}
const EXPECTED_KEY: string = API_KEY;

const store = new Store(DATA_DIR);

function buildApp(): FastifyInstance {
  const app = Fastify({ logger: true });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.statusCode).send({ error: err.code, message: err.message });
      return;
    }
    const e = err as any;
    if (e && e.validation) {
      reply.status(400).send({ error: "INVALID_REQUEST", message: e.message });
      return;
    }
    reply.status(500).send({ error: "INTERNAL", message: "unexpected error" });
  });

  // Auth: everything under /v1 requires the dumb key.
  app.addHook("onRequest", (req, reply, done) => {
    if (!req.url.startsWith("/v1/")) return done();
    const auth = req.headers.authorization || "";
    if (auth !== `Bearer ${EXPECTED_KEY}`) {
      reply.status(401).send({ error: "UNAUTHORIZED", message: "valid Bearer key required" });
      return;
    }
    done();
  });

  app.get("/health", async () => ({ ok: true, version: "0.1.0" }));

  // -- trips -----------------------------------------------------------------

  app.post("/v1/trips", async (req: FastifyRequest<{ Body: any }>) => {
    const body = (req.body || {}) as any;
    const reg = store.readRegistry();
    const tripId: string = body.trip_id || newTripId(body.name || "Untitled trip");
    if (reg.trips[tripId]) throw new ApiError("TRIP_ID_CONFLICT", `Trip id already exists: ${tripId}`, 409);

    const tripDir = path.join(DATA_DIR, "trips", tripId);
    fs.mkdirSync(path.join(tripDir, "proposals"), { recursive: true });

    const plan: Plan = body.plan || {
      version_id: newVersionId(1),
      parent_version_id: null,
      created_at: utcNow(),
      created_by: body.created_by || "init",
      days: [],
    };
    if (!plan.version_id) plan.version_id = newVersionId(1);

    store.writeJson(path.join(tripDir, "plan.json"), plan);
    if (body.constraints !== undefined) store.writeDoc(tripId, "constraints.yaml", body.constraints);
    if (body.rubrics !== undefined) store.writeDoc(tripId, "rubrics.yaml", body.rubrics);
    if (body.activities !== undefined) store.writeDoc(tripId, "activities.json", body.activities);
    fs.writeFileSync(path.join(tripDir, "plan.md"), renderPlanMd(plan, body.name || tripId));
    fs.writeFileSync(path.join(tripDir, "run-log.tsv"), "iteration\ttimestamp\tmutation_type\tdescription\tscore_before\tscore_after\tdelta\tkept\n");

    reg.trips[tripId] = {
      trip_id: tripId,
      name: body.name || tripId,
      created_at: utcNow(),
      status: "active",
      current_version_id: plan.version_id,
    };
    if (!reg.default_trip) reg.default_trip = tripId;
    store.writeRegistry(reg);
    return { trip_id: tripId, current_version_id: plan.version_id };
  });

  app.get("/v1/trips", async () => {
    const reg = store.readRegistry();
    return { trips: Object.values(reg.trips), default_trip: reg.default_trip };
  });

  app.get("/v1/trips/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const t = store.requireTrip(req.params.id);
    return {
      ...t,
      has_constraints: store.readDoc(t.trip_id, "constraints.yaml") !== null,
      has_rubrics: store.readDoc(t.trip_id, "rubrics.yaml") !== null,
      has_activities: store.readDoc(t.trip_id, "activities.json") !== null,
    };
  });

  app.delete("/v1/trips/:id", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    const t = store.requireTrip(req.params.id);
    fs.rmSync(path.join(DATA_DIR, "trips", t.trip_id), { recursive: true, force: true });
    const reg = store.readRegistry();
    delete reg.trips[t.trip_id];
    if (reg.default_trip === t.trip_id) reg.default_trip = Object.keys(reg.trips)[0] || null;
    store.writeRegistry(reg);
    return { deleted: t.trip_id };
  });

  // -- plan -------------------------------------------------------------------

  app.get(
    "/v1/trips/:id/plan",
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { day?: string; format?: string } }>) => {
      const plan = store.readPlan(req.params.id);
      if (req.query.day !== undefined) {
        const n = parseInt(req.query.day, 10);
        const day = plan.days.find((d) => d.day_index === n);
        if (!day) throw new ApiError("DAY_NOT_FOUND", `No day ${n} in plan`, 404);
        return { version_id: plan.version_id, day };
      }
      if (req.query.format === "md") {
        const trip = store.requireTrip(req.params.id);
        const md = fs.readFileSync(path.join(DATA_DIR, "trips", trip.trip_id, "plan.md"), "utf8");
        return { version_id: plan.version_id, markdown: md };
      }
      return plan;
    },
  );

  // Replace the whole plan (research baseline, migration). Bumps the version.
  app.put("/v1/trips/:id/plan", async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const trip = store.requireTrip(req.params.id);
    const current = store.readPlan(trip.trip_id);
    const body = (req.body || {}) as any;
    if (!body.plan || !Array.isArray(body.plan.days))
      throw new ApiError("INVALID_REQUEST", "body.plan.days[] is required", 400);
    const next: Plan = {
      ...body.plan,
      version_id: bumpVersionId(current.version_id),
      parent_version_id: current.version_id,
      created_at: utcNow(),
      created_by: body.created_by || "plan_replace",
    };
    store.writePlan(trip.trip_id, next);
    fs.writeFileSync(
      path.join(DATA_DIR, "trips", trip.trip_id, "plan.md"),
      renderPlanMd(next, trip.name),
    );
    return { version_id: next.version_id, parent_version_id: next.parent_version_id };
  });

  // -- doc files ---------------------------------------------------------------

  const DOCS = ["constraints.yaml", "rubrics.yaml", "activities.json"] as const;

  for (const doc of DOCS) {
    const route = doc.replace(/\.(yaml|json)$/, "");
    app.get(`/v1/trips/:id/${route}`, async (req: FastifyRequest<{ Params: { id: string } }>) => {
      const v = store.readDoc(req.params.id, doc);
      if (v === null) throw new ApiError("DOC_NOT_FOUND", `No ${doc} for trip`, 404);
      return { doc, content: v };
    });
    app.put(
      `/v1/trips/:id/${route}`,
      async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
        const b = (req.body || {}) as any;
        if (b.content === undefined)
          throw new ApiError("INVALID_REQUEST", "body.content is required", 400);
        store.writeDoc(req.params.id, doc, b.content);
        return { doc, updated: true };
      },
    );
  }

  // -- proposals ----------------------------------------------------------------

  app.post("/v1/trips/:id/proposals", async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const trip = store.requireTrip(req.params.id);
    const body = (req.body || {}) as any;
    const current = store.readPlan(trip.trip_id);
    const baseVersionId: string = body.base_version_id || current.version_id;
    // Validate the base version exists (is an ancestor-or-current of current).
    try {
      const baseN = parseVersionId(baseVersionId);
      const curN = parseVersionId(current.version_id);
      if (baseN < 1 || baseN > curN)
        throw new ApiError("INVALID_VERSION", `base_version_id ${baseVersionId} is not reachable`, 400);
    } catch (e) {
      if (e instanceof ApiError) throw e;
      throw new ApiError("INVALID_VERSION", `bad base_version_id: ${baseVersionId}`, 400);
    }

    const proposalId: string = body.proposal_id || newProposalId(body.raw_request);
    const proposal: Proposal = {
      proposal_id: proposalId,
      trip_id: trip.trip_id,
      base_version_id: baseVersionId,
      status: body.status || "pending",
      requested_by: body.requested_by || "agent",
      requested_at: utcNow(),
      request_language: body.request_language,
      raw_request: body.raw_request,
      intent: body.intent,
      scope: body.scope,
      candidate_plan: body.candidate_plan ?? null,
      impact_summary: body.impact_summary ?? null,
      explanation: body.explanation,
      clarification: body.clarification,
    };
    if (store.listProposals(trip.trip_id).some((p) => p.proposal_id === proposalId))
      throw new ApiError("PROPOSAL_ID_CONFLICT", `Proposal already exists: ${proposalId}`, 409);
    store.writeProposal(trip.trip_id, proposal);
    return { proposal_id: proposalId, status: proposal.status, base_version_id: baseVersionId };
  });

  app.get(
    "/v1/trips/:id/proposals",
    async (req: FastifyRequest<{ Params: { id: string }; Querystring: { status?: string } }>) => {
      const status = req.query.status as ProposalStatus | undefined;
      if (status && !["pending", "applied", "rejected", "needs_clarification"].includes(status))
        throw new ApiError("INVALID_REQUEST", `bad status: ${status}`, 400);
      return { proposals: store.listProposals(req.params.id, status) };
    },
  );

  app.get("/v1/proposals/:pid", async (req: FastifyRequest<{ Params: { pid: string } }>) => {
    return store.findProposal(req.params.pid).proposal;
  });

  app.post("/v1/proposals/:pid/apply", async (req: FastifyRequest<{ Params: { pid: string } }>) => {
    const { tripId, proposal } = store.findProposal(req.params.pid);
    if (proposal.status === "applied")
      return { proposal_id: proposal.proposal_id, status: "applied", already_applied: true, resulting_version_id: proposal.resulting_version_id };
    if (proposal.status !== "pending")
      throw new ApiError("PROPOSAL_NOT_APPLICABLE", `Proposal is ${proposal.status}`, 409);
    if (!proposal.candidate_plan)
      throw new ApiError("PROPOSAL_NOT_APPLICABLE", "Proposal has no candidate_plan (needs_clarification?)", 409);

    const trip = store.requireTrip(tripId);
    const current = store.readPlan(tripId);
    if (current.version_id !== proposal.base_version_id) {
      throw new ApiError(
        "PROPOSAL_CONFLICT",
        `Proposal based on ${proposal.base_version_id} but current is ${current.version_id}; regenerate against current version`,
        409,
      );
    }

    const next: Plan = {
      ...proposal.candidate_plan,
      version_id: bumpVersionId(current.version_id),
      parent_version_id: current.version_id,
      created_at: utcNow(),
      created_by: `proposal:${proposal.proposal_id}`,
    };
    store.writePlan(tripId, next);
    fs.writeFileSync(
      path.join(DATA_DIR, "trips", tripId, "plan.md"),
      renderPlanMd(next, trip.name),
    );
    proposal.status = "applied";
    proposal.applied_at = utcNow();
    proposal.resulting_version_id = next.version_id;
    store.writeProposal(tripId, proposal);

    const delta =
      proposal.impact_summary?.score_delta ??
      (proposal.impact_summary?.score_before !== undefined && proposal.impact_summary?.score_after !== undefined
        ? +(proposal.impact_summary.score_after - proposal.impact_summary.score_before).toFixed(2)
        : undefined);
    store.appendRunLog(tripId, {
      mutation_type: "APPLY",
      description: proposal.raw_request || proposal.proposal_id,
      score_before: proposal.impact_summary?.score_before,
      score_after: proposal.impact_summary?.score_after,
      kept: true,
    });

    return {
      proposal_id: proposal.proposal_id,
      status: "applied",
      resulting_version_id: next.version_id,
      parent_version_id: next.parent_version_id,
      score_delta: delta,
    };
  });

  app.post(
    "/v1/proposals/:pid/reject",
    async (req: FastifyRequest<{ Params: { pid: string }; Body: any }>) => {
      const { tripId, proposal } = store.findProposal(req.params.pid);
      if (proposal.status !== "pending")
        throw new ApiError("PROPOSAL_NOT_APPLICABLE", `Proposal is ${proposal.status}`, 409);
      proposal.status = "rejected";
      proposal.rejection_reason = (req.body as any)?.reason;
      store.writeProposal(tripId, proposal);
      return { proposal_id: proposal.proposal_id, status: "rejected" };
    },
  );

  // -- run log -------------------------------------------------------------------

  app.post("/v1/trips/:id/run-log", async (req: FastifyRequest<{ Params: { id: string }; Body: any }>) => {
    const body = (req.body || {}) as any;
    if (!body.mutation_type || body.kept === undefined)
      throw new ApiError("INVALID_REQUEST", "mutation_type and kept are required", 400);
    const iteration = store.appendRunLog(req.params.id, {
      mutation_type: body.mutation_type,
      description: body.description || "",
      score_before: body.score_before,
      score_after: body.score_after,
      kept: !!body.kept,
    });
    return { iteration };
  });

  app.get("/v1/trips/:id/run-log", async (req: FastifyRequest<{ Params: { id: string } }>) => {
    return { tsv: store.readRunLog(req.params.id) };
  });

  // -- profile --------------------------------------------------------------------

  app.get("/v1/profile", async () => ({ profile: store.readProfile() }));
  app.put("/v1/profile", async (req: FastifyRequest<{ Body: any }>) => {
    const b = (req.body || {}) as any;
    store.writeProfile(b.profile ?? b ?? {});
    return { updated: true };
  });

  return app;
}

if (require.main === module) {
  const app = buildApp();
  app.listen({ port: PORT, host: "0.0.0.0" }).then(() => {
    console.log(`[trip-optimizer] listening on :${PORT}, data=${DATA_DIR}`);
  });
}

export { buildApp };
