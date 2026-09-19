# trip-optimizer-service

Deterministic state API for the Trip Optimizer connector (option 2: hosted service).

**The agent does all LLM reasoning** — trip interviews, research synthesis, rubric
generation, three-pass scoring, proposal drafting, plan Q&A, debrief distillation.
This service owns **no judgment**. It owns:

- trip registry + per-trip file layout (mirrors the skill's data model)
- versioned `plan.json` (`v_NNN`, `parent_version_id`)
- proposal lifecycle: create → pending → applied / rejected, with
  `PROPOSAL_CONFLICT` (409) on stale `base_version_id` — never force-apply
- `plan.md` re-rendering on every applied change
- append-only run log (`run-log.tsv`)

## Run locally

```bash
npm install
npm run dev            # tsx, port 8787
# or
npm run build && npm start
```

Env:

| Var | Default | Purpose |
|---|---|---|
| `PORT` | `8787` | listen port |
| `DATA_DIR` | `./data` | file storage root |
| `TRIP_OPTIMIZER_API_KEY` | (random, printed at boot) | dumb shared Bearer key |

All `/v1/*` routes require `Authorization: Bearer <key>`. `/health` is open.

## API

See `openapi.yaml`. Core flow:

```
POST /v1/trips                        → { trip_id }            # init
PUT  /v1/trips/:id/constraints|rubrics|activities               # research output
PUT  /v1/trips/:id/plan               → { version_id }         # baseline plan
POST /v1/trips/:id/proposals          → { proposal_id }        # propose
POST /v1/proposals/:pid/apply         → { resulting_version_id } # apply (409 if stale)
POST /v1/trips/:id/run-log            → { iteration }          # optimization loop
GET  /v1/trips/:id/plan?format=md                              # rendered itinerary
```

## Deploy (Oracle Cloud VM)

```bash
# on the VM
git clone <repo> && cd trip-optimizer-service
npm install && npm run build
TRIP_OPTIMIZER_API_KEY=<dumb-key> DATA_DIR=/var/lib/trip-optimizer PORT=8787 \
  node dist/index.js
```

Front with Caddy for TLS; point the Muse Custom Connector at `https://<host>/`.

## License

MIT
