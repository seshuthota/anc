# DemoCo architecture

## Purpose

DemoCo is a local investigation workspace for a fictional Indian parcel network. Company records (hubs, route runs, shipments, lockers, shippers, complaints) are read through MCP. The one company write is complaint assignment. It turns a question into bounded specialist investigations, keeps the resulting evidence in runtime state, and presents only verified information in a generated workspace.

## Runtime path

```text
Browser shell
  ↕ agent SSE (POST /runtime/investigate, GET /runtime/events)
Agent runtime
  ├─ validates semantic user events
  ├─ plans and schedules domain tasks
  ├─ persists activity, evidence, findings, and surfaces
  └─ gives verified presentation data to the UI composer
       ↕ MCP client
Logistics MCP server → logistics SQLite database
       ↓
UI composer → A2UI surface → Browser workspace
```

The web app contains only the shell, activity feed, input, persona switcher, and workspace renderer. It does not query company data. The agent runtime does not import the company database package for investigation logic; specialists use only authorized tools through the MCP client. Trusted principal identity is passed in process environment (`ANC_PRINCIPAL_ID`), never in model-controlled tool arguments. In demo mode the browser may send `x-anc-principal`. In OpenID mode that header is ignored. The web app verifies the issuer's identity token, stores an httpOnly session, and forwards a short-lived signed hop to the agent. The UI composer has no MCP or database access. A2UI v0.9 messages are composed from verified presentation data and artifacts and mounted in the workspace with a basic-catalog adapter (`apps/web/lib/a2ui.tsx`). The shell consumes agent SSE directly. `/api/copilotkit` remains an optional CopilotKit proxy to `/ag-ui` and is not used by the workspace page.

Five seeded DemoCo personas share the same shell (COO, Hyderabad hub supervisor, last-mile lead, key account manager, customer care lead). Grants, not job titles, authorize tools and fields. Sessions, evidence, artifacts, and surfaces are owned. The COO session reuses the historical `local-demo` thread. Hub status, at-risk shipments, locker capacity, shipper commitments, and complaint assignment are registry/tool capabilities, not dedicated frontend routes.

Planning: fixture mode scores authorized capability descriptions against the objective and schedules up to four specialist domains in parallel for a broad morning briefing (network, shipments, last_mile, customers). Live mode sends capability schemas, user context, completed capabilities, and the objective to the model. The runtime validates domain, grants, write exclusion, and a task cap before scheduling. Requests are scored against the whole capability catalog rather than the granted subset, so a request the persona may not serve returns an explicit limitation naming the domain and the alternatives they do have, instead of silently matching an adjacent authorized capability. A request to perform a write is refused when the write capability is not granted, rather than degrading to the matching read. Reroute, dispatch, and redeliver requests are refused.

Composition chooses the view from the capabilities that were actually scheduled, not from the wording of the request, so paraphrases converge on the same interface without extra routing branches. It selects tables, metrics, charts, drafts and actions from artifact kinds, row metadata and entity types. Table totals come from the tool's own arithmetic rather than the model. Model-authored drafts are labelled as proposals, state their unverified premises as explicit assumptions, and never present as observed facts or completed operations.

## State and persistence

Company data is seeded deterministically (`pnpm logistics:seed`) and opened by the MCP server. Runtime state is saved independently: graph checkpoints retain thread-level progress, while evidence, task traces, activity entries, and accepted UI surfaces are append-only records. An evidence record is committed before a finding that cites it; a surface is saved only after its referenced findings exist.

Graph state stores IDs and compact summaries. Full evidence payloads remain in runtime storage and are provided to a specialist only when relevant to its bounded task. Concurrent results are merged by stable ID; specialists cannot overwrite other specialists' findings.

## Trust boundaries

Every MCP tool validates inputs and returns a typed evidence envelope. The runtime validates all agent results: evidence IDs must exist, entities must be known, and numeric claims must resolve to evidence values or allowed deterministic derivations. Observations, hypotheses, and unresolved questions remain distinct in the presentation model.

Generated A2UI actions include a known intent, entity references, and the surface revision. The runtime validates each action, deduplicates action IDs, and rejects stale references before beginning another task. The company write is complaint assignment. A separate external note can be posted only when that connector is explicitly enabled, and its credential stays on the server. Saved views are checked against current grants on every read. Revoked access withholds the saved body. Erasure removes that person's evidence, surfaces, and graph checkpoints.

## Main investigation

The broad morning question schedules Network, Shipments, Last-Mile, and Customers tasks in parallel. Their evidence can establish hub equipment faults, parcels at risk of missing today's promise, locker capacity pressure, and key-account commitment impact. The orchestrator merges verified findings, asks the UI composer for a new surface, and streams high-level events such as agent started, tool queried, finding discovered, and completed. It never sends model reasoning to the browser.

## Failure behavior

Each task can complete, return partial results, or fail. A Customers Agent failure leaves network and shipments findings visible with a clear unavailable state. A malformed agent result can receive one repair attempt; a malformed UI surface leaves the previous accepted surface rendered. Cancelling a run prevents later work from becoming the active surface. An older run cannot replace a newer workspace on the same thread. Refresh restores the last accepted surface and reconnects to an in-flight run via `GET /runtime/events`.

Pre-parcel wording for this document is preserved in [archive/pre-parcel-architecture-2026-10-08.md](archive/pre-parcel-architecture-2026-10-08.md).
