# DemoCo architecture

## Purpose

DemoCo is a local investigation workspace for a fictional B2B SaaS company. Company records are read through MCP. The one company write is a support-ticket assignment. It turns a question into bounded specialist investigations, keeps the resulting evidence in runtime state, and presents only verified information in a generated workspace.

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
Company MCP server → company SQLite database
       ↓
UI composer → A2UI surface → Browser workspace
```

The web app contains only the shell, activity feed, input, persona switcher, and workspace renderer. It does not query company data. The agent runtime does not import the company database package for investigation logic; specialists use only authorized tools through the MCP client. Trusted principal identity is passed in process environment (`ANC_PRINCIPAL_ID`), never in model-controlled tool arguments. In demo mode the browser may send `x-anc-principal`. In OpenID mode that header is ignored. The web app verifies the issuer's identity token, stores an httpOnly session, and forwards a short-lived signed hop to the agent. The UI composer has no MCP or database access. A2UI v0.9 messages are composed from verified presentation data and artifacts and mounted in the workspace with a basic-catalog adapter (`apps/web/lib/a2ui.tsx`). The shell consumes agent SSE directly. `/api/copilotkit` remains an optional CopilotKit proxy to `/ag-ui` and is not used by the workspace page.

Four seeded DemoCo personas share the same shell. Grants, not job titles, authorize tools and fields. Sessions, evidence, artifacts, and surfaces are owned. The COO session reuses the historical `local-demo` thread. Invoice aging, ticket assignment, and open incidents are registry/tool capabilities, not dedicated frontend routes.

Planning: fixture mode scores authorized capability descriptions against the objective, then may add one finance follow-up once affected accounts exist. Live mode sends capability schemas, user context, completed capabilities, and the objective to the model for both the first plan and that follow-up. The runtime validates domain, grants, write exclusion, and a three-task cap before scheduling. Requests are scored against the whole capability catalog rather than the granted subset, so a request the persona may not serve returns an explicit limitation naming the domain and the alternatives they do have, instead of silently matching an adjacent authorized capability. A request to perform a write is refused when the write capability is not granted, rather than degrading to the matching read.

Composition chooses the view from the capabilities that were actually scheduled, not from the wording of the request, so paraphrases converge on the same interface without extra routing branches. It selects tables, metrics, charts, drafts and actions from artifact kinds, row metadata and entity types, and does not switch on invoice or ticket intent names. Table totals come from the tool's own arithmetic rather than the model. Row entity ids are resolved from the row's entity type, so a `customer` row carries a customer id even when the underlying record is an invoice. Model-authored drafts are labelled as proposals, carry their unverified premises as explicit assumptions, and never present as observed facts or completed operations.

## State and persistence

Company data is seeded deterministically and opened read-only. Runtime state is saved independently: graph checkpoints retain thread-level progress, while evidence, task traces, activity entries, and accepted UI surfaces are append-only records. An evidence record is committed before a finding that cites it; a surface is saved only after its referenced findings exist.

Graph state stores IDs and compact summaries. Full evidence payloads remain in runtime storage and are provided to a specialist only when relevant to its bounded task. Concurrent results are merged by stable ID; specialists cannot overwrite other specialists' findings.

## Trust boundaries

Every MCP tool validates inputs and returns a typed evidence envelope. The runtime validates all agent results: evidence IDs must exist, entities must be known, and numeric claims must resolve to evidence values or allowed deterministic derivations. Observations, hypotheses, and unresolved questions remain distinct in the presentation model.

Generated A2UI actions carry a known intent, entity references, and the surface revision. The runtime validates each action, deduplicates action IDs, and rejects stale references before beginning another task. The company write is support-ticket assignment. A separate external note can be posted only when that connector is explicitly enabled, and its credential stays on the server. Saved views are checked against current grants on every read. Revoked access withholds the saved body. Erasure removes that person's evidence, surfaces, and graph checkpoints.

## Main investigation

The broad morning question schedules Reliability, Product, and Customer tasks in parallel. Their evidence can establish timing, anomalous usage, and affected accounts. Once the affected customer set is known, Finance calculates represented ARR. The orchestrator merges verified findings, asks the UI composer for a new surface, and streams high-level events such as agent started, tool queried, finding discovered, and completed. It never sends model reasoning to the browser.

## Failure behavior

Each task can complete, return partial results, or fail. A Finance failure leaves operational and customer findings visible with a clear unavailable state. A malformed agent result can receive one repair attempt; a malformed UI surface leaves the previous accepted surface rendered. Cancelling a run prevents later work from becoming the active surface. An older run cannot replace a newer workspace on the same thread. Refresh restores the last accepted surface and reconnects to an in-flight run via `GET /runtime/events`.
