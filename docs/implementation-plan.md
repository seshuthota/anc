# Agent-Native Enterprise Workspace: implementation plan

Status: proposed; implementation has not started.
Source: [original specification](../idea.md).
Prepared: 2026-09-20.

## 1. Outcome and scope

Build a local, read-only application for a fictional SaaS company. A person asks a business question; specialist agents investigate through MCP; the runtime retains evidence and findings; a composer produces an A2UI workspace that supports follow-up investigation.

The first demonstration must support this sequence without predefined business pages:

1. “What should I care about this morning?”
2. “Why is this happening?”
3. “Who is affected?”
4. Select an account and inspect its usage, support history, and ARR.
5. Open the evidence supporting a claim.
6. Refresh and continue from saved state.

The experiment succeeds when an unfamiliar user can answer those questions and verify the answers. A changing layout alone is insufficient.

Retain the specified stack: TypeScript, pnpm, Next.js/React, CopilotKit, AG-UI, A2UI, LangGraph, official MCP TypeScript SDK v2, SQLite, and Zod. Validate and pin compatible versions in the first milestone. Do not invent a UI protocol if an integration proves awkward.

Exclude authentication, production roles, company-changing operations, external SaaS integrations, arbitrary SQL, vector databases, distributed infrastructure, long-term agent memory, and deployment work. Local runtime persistence is in scope. Bind development services to localhost and use synthetic data only.

## 2. Architecture and responsibility boundaries

```text
Browser: fixed shell, generated workspace, activity, input
  ↕ CopilotKit / AG-UI
Agent runtime: orchestration, specialists, validation, persistence
  ↕ MCP                                   ↓ verified findings
Company MCP server                        UI composer
  ↓ read-only                               ↓ A2UI messages
company.sqlite                            Browser renderer

Runtime persistence → runtime.sqlite
  checkpoints, evidence, traces, saved A2UI surfaces
```

There are six responsibilities: orchestrator, four domain specialists, and UI composer. Start with one configurable model shared across them, separate instructions, and enforced tool allowlists. They do not require six services.

| Component | Owns | Must not do |
| --- | --- | --- |
| Orchestrator | Objective, task dependencies, follow-ups, synthesis | Query company data directly |
| Domain specialist | Investigation within an assigned domain | Generate layouts or use another domain's tools |
| MCP server | Validated domain queries and deterministic calculations | Accept arbitrary SQL or company writes |
| Runtime | Evidence ledger, finding validation, state merges, budgets | Depend on model memory for correctness |
| UI composer | Selection and arrangement of verified information | Query company systems or invent values |
| Frontend | Rendering, selection, history, semantic input events | Fetch company data directly |

Business data is immutable during a demo. The seed command creates it; the MCP process opens it read-only. Runtime state has a separate writable database. Frontend access to saved runtime evidence through the agent service is allowed; this does not bypass MCP to query company systems.

## 3. Repository and developer workflow

```text
apps/
  web/                  Next.js shell and CopilotKit endpoint
  agent/                LangGraph runtime, CLI, transport adapter
  company-mcp/          MCP server and domain tool registration
packages/
  contracts/            Zod schemas and inferred TypeScript types
  database/             Company schema, migrations, deterministic seeds
  runtime-storage/      Evidence, checkpoints, surfaces, activity records
  config/               Environment parsing and shared settings
tests/
  integration/          Real MCP and runtime tests
  e2e/                  Browser flows
  evals/                Live model scenarios and scoring
  fixtures/             Recorded responses and private expected outcomes
docs/
  architecture.md
  implementation-plan.md
  compatibility.md
  demo-scenario.md
  evaluation-results.md
```

Keep database imports out of web and specialist code using package exports and lint restrictions. Specialists depend on the MCP client, contracts, and model adapter. Test-only expected outcomes must never be included in agent prompts, tool responses, or shipped application bundles.

Planned root commands:

| Command | Purpose |
| --- | --- |
| `pnpm dev` | Start web and agent; agent starts its local MCP child process |
| `pnpm db:seed --scenario sync-regression` | Create deterministic company data |
| `pnpm investigate -- "What should I care about this morning?"` | Run an investigation from CLI |
| `pnpm typecheck` / `pnpm lint` | Static checks |
| `pnpm test` | Deterministic unit and integration checks |
| `pnpm test:e2e` | Browser verification with fixture model responses |
| `pnpm eval:live` | Explicit, paid model evaluation |
| `pnpm replay --run <id>` | View saved results without new model calls |

Environment settings: provider API key, model ID, company DB path, runtime DB path, demo clock, and budget limits. Keep secrets server-side. Document configuration in `.env.example` without real credentials. Select the provider before implementing live specialists; keep its integration behind a small adapter supporting tool calls, structured results, cancellation, and usage reporting.

## 4. Core contracts

Implement Zod schemas first and derive TypeScript types. Version persisted contracts. Reject malformed structures at tool, agent, action, and UI boundaries.

### Evidence

Each successful tool call returns an immutable evidence envelope containing:

- `evidenceId`, `tool`, `toolVersion`, and `source`.
- Normalized arguments and the applied filters.
- Observation window, aggregation grain, timezone, and data-as-of time.
- Retrieval time, seed/dataset version, units, and currency where applicable.
- Structured result, including pagination and completeness information.
- A payload hash for integrity checks.

The runtime records which run/task/tool call produced the evidence before making it available to the model. Failed calls produce typed errors, not fabricated evidence. Deduplicate identical reads within the same immutable dataset/window when useful, while retaining tool-call trace records.

### Findings and claims

Extend the specification's `AgentFinding` with:

- Authoring task and agent IDs.
- `kind`: observation, hypothesis, or unresolved question.
- Structured claims referencing evidence IDs and specific result fields or rows.
- Time window and entities being described.
- Severity, limitations, and optional contradictory evidence references.
- Metrics with explicit units, comparison windows, and aggregation semantics.

Evidence existence is necessary but does not prove that a claim follows from it. Validate numeric claims against referenced fields or allowlisted deterministic derivations. Narrative causal claims remain hypotheses unless additional evidence supports them. Never convert an agent's subjective confidence into a measured probability.

ARR represented by affected accounts is a precise metric. Revenue loss or renewal risk is a different claim and must not be inferred from ARR alone.

### Tasks and results

`InvestigationTask` contains ID, domain, question, entity scope, time window, dependencies, status, and attempt count. A plan must be acyclic and use known domains. Results have completed/partial/failed status, validated findings, unresolved questions, and suggested follow-ups.

The orchestrator proposes tasks; runtime code validates and schedules them. Tool permissions are enforced by code, not only by prompts.

### Shared state

Store objective, thread/investigation/run IDs, resolved demo time, task map, finding map, evidence references, selected entities, active surface reference, navigation history, budgets, and current status in graph state.

Keep full evidence payloads and event history in runtime storage; do not repeatedly copy them into every checkpoint or model context. Build a bounded context for each task from relevant findings and evidence.

Use stable-ID map reducers for concurrent results. A specialist contributes its result; it cannot replace another specialist's state. The orchestrator alone changes investigation status. Contradictory findings remain visible until resolved or marked unresolved.

### Semantic actions

An action envelope contains action name, action ID, thread/investigation ID, surface ID/revision, and entity references. Initial names: investigate, show_affected_accounts, inspect_release, inspect_account, inspect_financial_impact, show_evidence, and retry_task.

These are business intents carried using the chosen A2UI action mechanism, not a replacement UI schema. Validate names and entity references server-side. Deduplicate action IDs. Reject or explicitly rebase actions from stale surfaces. Evidence inspection can use saved runtime data without another model call.

## 5. Synthetic data and tool semantics

Use a fixed scenario clock: `2026-09-20T08:00:00Z`. Resolve “this morning,” “yesterday,” and baseline periods against that clock, not the developer's actual date. Display the scenario time and timezone clearly.

Seed approximately the original requested volumes: 100 customers/subscriptions, 30 days of metrics, 10 releases, 200 support tickets, 500 invoices, several thousand usage records, and five historical incidents. Add enough higher-resolution records around the regression to support the timeline.

| Data | Required fields or additions |
| --- | --- |
| Customers | Stable ID, segment, timezone |
| Configuration history | Customer, feature/config value, effective start/end |
| Subscriptions | Customer, status, term, ARR in integer minor units, currency |
| Service metrics | Time bucket, service, customer/cohort, requests, errors, signature |
| Feature usage | Time bucket, customer, feature, usage count |
| Releases and rollouts | Components, version, deployment time, cohort, rollout timing |
| Support tickets | Customer, creation time, category, status, text |
| Incidents, invoices, notes | Domain history with foreign keys and timestamps |

Store counts so aggregate error rates are `sum(errors) / sum(requests)`, not averages of percentages. Define zero denominators and missing buckets explicitly. Compare periods with equal duration and comparable cohort membership. Use one demo currency initially. Sum ARR once per affected account.

Target the illustrative 14 accounts and $2.1M ARR if convenient; ensure all displayed totals are computed from seeded rows. Choose counts that produce the target trends within documented rounding tolerances. Never hardcode totals in prompts or UI.

No row should announce the root cause. Include unaffected customers with the same feature, unrelated support noise, and other recent releases so comparison is meaningful.

Initial tool slice:

| Domain | Tools needed for first complete story |
| --- | --- |
| Reliability | `get_service_health`, `get_error_metrics`, `get_recent_releases`, `get_release_details` |
| Product | `get_feature_usage`, `compare_usage_periods`, `get_customer_feature_usage` |
| Customer | `search_customers`, `get_customer`, `search_support_tickets`, `get_customer_support_history` |
| Finance | `calculate_account_exposure`, `get_subscription` |

Existing tools need explicit filters for customer IDs, cohort/configuration, feature, service, and time window as applicable. Include configuration history in customer detail and rollout details in release detail. If these cannot answer a concrete investigation question, add a narrowly defined tool, not generic SQL.

Return totals and pagination metadata from searches. Ticket complainants are not automatically the full affected population: derive technical impact from telemetry, then enrich with support data. Finance accepts the validated affected-customer set and reports its definition with the result.

## 6. Implementation milestones

### M0 — Protocol and persistence spike

Dependencies: none. Estimated effort: 1–2 focused engineering days.

- [ ] Create pnpm workspace, TypeScript config, minimal app processes, and environment validation.
- [ ] Verify exact supported versions of CopilotKit, AG-UI adapter, A2UI specification/catalog, LangGraph, MCP SDK, Zod, and Node.
- [ ] Record imports, versions, transport choices, and working example references in `docs/compatibility.md`.
- [ ] Implement one MCP tool reading one seeded SQLite fact.
- [ ] Connect one minimal graph task to that tool through the actual MCP transport.
- [ ] Send the result through AG-UI and render a standard A2UI surface inside the dedicated workspace area.
- [ ] Click a generated action and receive its semantic context in the agent runtime.
- [ ] Update the same surface and confirm the renderer does not require appending a new chat message.
- [ ] Verify a persistent LangGraph checkpointer against the chosen TypeScript package versions and restart once.
- [ ] Write `docs/architecture.md` with the validated boundaries.

Completion gate: real browser → runtime → MCP → SQLite → generated UI → action round trip works; process restart restores the checkpoint. One disposable fixture surface is acceptable here. Do not build the full company dataset before this gate.

Risk response: if the standard renderer needs a thin workspace mounting adapter, document it and reuse its actual A2UI renderer. Do not silently substitute a homegrown renderer or downgrade to text-only chat. Simplify unsupported visuals to standard components first.

### M1 — Data, contracts, and evidence ledger

Dependencies: M0. Estimated effort: 2–3 days.

- [ ] Implement schemas and seed generation described above.
- [ ] Add canonical entity references, task/results, findings, evidence, and action contracts.
- [ ] Add runtime tables for immutable evidence, runs, tasks, activity, and saved surfaces.
- [ ] Implement the fixed clock, deterministic seed, and dataset versioning.
- [ ] Seed regression, quiet-day, and unrelated-anomaly variants.
- [ ] Write an independent expected-outcome fixture from raw rows.
- [ ] Add tests for foreign keys, temporal ordering, impacted cohort, ARR, weighted rates, and comparison windows.

Completion gate: repeated seeding gives identical business rows, all headline metrics are reproducible, and no runtime-accessible record contains the complete explanation.

### M2 — Company capabilities over MCP

Dependencies: M1. Estimated effort: 1–2 days.

- [ ] Implement the initial domain tools and register validated input/output schemas.
- [ ] Use a local stdio MCP connection managed by the agent process; keep one server initially.
- [ ] Return evidence envelopes, typed empty results, pagination, and bounded errors.
- [ ] Wrap client calls with runtime tracing and evidence persistence.
- [ ] Enforce specialist tool allowlists and read-only SQLite access.
- [ ] Integration-test actual MCP calls, invalid ranges/IDs, missing data, pagination, and cancellation/error propagation where supported.

Completion gate: all facts needed for the main story can be retrieved through domain tools. No specialist imports the database package, and company rows remain unchanged after a run.

### M3 — Specialist agents in isolation

Dependencies: M2 and configured model provider. Estimated effort: 2–3 days.

- [ ] Implement a reusable bounded tool-calling loop and provider adapter.
- [ ] Add Reliability, Product, Customer, and Finance prompts and allowlists.
- [ ] Validate final structured results; allow one repair attempt for malformed output.
- [ ] Reject unknown evidence IDs, unknown entities, and unsupported numeric claims.
- [ ] Pass only relevant task context; treat ticket and note text as untrusted data.
- [ ] Support explicit partial results, missing-data reports, and cross-domain follow-up requests.
- [ ] Add CLI tasks for each specialist and record usage/latency.

Completion gate: each specialist solves a bounded domain question using real tools and returns traceable findings. Injected instructions in a ticket cannot grant tools or change the system objective.

### M4 — Orchestration and durable investigation

Dependencies: M3. Estimated effort: 2–3 days.

- [ ] Implement graph stages: resolve context → plan → validate/schedule → execute ready tasks → merge → assess gaps → compose → finish.
- [ ] Let the model select relevant domains and dependencies; do not route by matching the demo query text.
- [ ] Execute independent tasks concurrently, with at most three specialist tasks active initially.
- [ ] Let early results schedule dependent finance work once an affected set is available.
- [ ] Emit partial findings while other specialists are working.
- [ ] Add follow-up task deduplication and evidence reuse scoped by dataset, entities, and time window.
- [ ] Persist graph checkpoints under a stable thread ID and separate per-turn run IDs.
- [ ] Record contradictory findings and allow a bounded clarification investigation.
- [ ] Implement cancellation and prevent cancelled/superseded runs from publishing a current surface.

Initial configurable limits: three investigation rounds, 12 specialist tasks per user turn, six tool calls per task, three concurrent specialists, one structured-output repair, and a 120-second run deadline. Also cap total model tokens and record actual usage. These are starting guardrails to tune from measurements.

Completion gate: CLI handles the full main investigation and follow-up questions; at least two independent tasks overlap; a failed Finance task preserves operational findings; restart recovers completed state.

### M5 — Verified A2UI composition

Dependencies: M4 and M0 renderer proof. Estimated effort: 2–3 days.

- [ ] Build a presentation input containing verified findings, approved metric values, entities, limitations, and allowed follow-up actions.
- [ ] Give the composer no company tools or database access.
- [ ] Generate native A2UI messages against the pinned specification and catalog.
- [ ] Validate component references, surface IDs, data bindings, action payloads, and resource limits.
- [ ] Bind displayed business values to approved presentation data where the renderer supports it; check any duplicated literals against that data.
- [ ] Preserve claim-to-evidence links in presentation metadata without inventing a component protocol.
- [ ] Keep stable surface/component IDs where practical; apply complete valid update batches.
- [ ] Save accepted A2UI messages and presentation data with surface revisions.
- [ ] On invalid output, allow one repair, then preserve the last valid surface with a concise failure status.

Start with the catalog's supported text, layout, list, button, and form primitives. Use tables/charts only if supported by the verified renderer. A chart extension is optional after the complete flow works.

Completion gate: changing findings produces a corresponding workspace; every displayed headline number maps to evidence; invalid output does not blank the application; no `IncidentPage` or `CustomerPage` is needed.

### M6 — Interactive workspace and live activity

Dependencies: M5. Estimated effort: 2–3 days.

- [ ] Build the fixed header, workspace, activity panel, and input.
- [ ] Show waiting, running, partial, completed, cancelled, and failed states.
- [ ] Map AG-UI run/step/tool/state events to concise activity entries; never display private reasoning.
- [ ] Forward generated actions through the agent runtime with selection and investigation context.
- [ ] Add evidence inspection showing source, filters, time window, result, and limitations.
- [ ] Keep a surface history and back action; restore old surfaces without model regeneration.
- [ ] Persist current selection and restore it on refresh.
- [ ] Use one active run per thread initially; provide cancel-and-replace for a new request.
- [ ] On reconnect, fetch persisted state and surface revision. Event-level resume is optional; state recovery is mandatory.
- [ ] Verify keyboard access, focus preservation, narrow layouts, and long content.

Completion gate: complete the four-step demo in the browser, inspect evidence, go back, refresh, and continue. Activity arrives before completion; partial UI updates do not steal keyboard focus.

### M7 — Evaluation, failures, and handoff

Dependencies: M6. Estimated effort: 2–3 days.

- [ ] Add deterministic end-to-end fixtures and real-model evaluation runs.
- [ ] Run the scenario and failure matrix below.
- [ ] Measure time to first activity, first useful finding, completed workspace, token usage, and model cost when pricing is configured.
- [ ] Remove any scenario-specific query routing or prompt hints found during review.
- [ ] Document setup, reset, seed selection, CLI usage, replay, and known limitations.
- [ ] Update this plan's checkboxes and write `docs/evaluation-results.md` with actual results.
- [ ] Ask an unfamiliar person to investigate and verify a claim; record confusing transitions.

Completion gate: all deterministic checks pass, live evaluation thresholds are met or explicitly reported as unmet, and the application starts from documented commands in a clean checkout.

## 7. Testing and evaluation

Use deterministic tests for calculations, permissions, state transitions, contracts, persistence, and rendering behavior. Use recorded/fixture model responses for CI; use real models to measure investigative quality. Mock-based success alone does not validate the central experiment.

| Scenario | Expected behavior |
| --- | --- |
| Sync regression | Connect telemetry, usage, affected configuration/accounts, and represented ARR; label root cause as a hypothesis unless supported |
| Quiet day | Report no major supported anomaly; do not invent an incident |
| Unrelated anomaly | Follow its evidence rather than always blaming synchronization |
| Paraphrased opening query | Investigate without exact-string routing |
| Narrow finance question | Use Finance directly without unnecessarily launching all specialists |
| Finance timeout | Show verified operational impact and financial information unavailable |
| Conflicting time windows | Normalize or explain the disagreement; do not silently merge |
| Unknown customer | Show a grounded empty result and preserve current context |
| Malformed A2UI | Repair once or retain last valid surface |
| Duplicate or stale click | Avoid duplicate tasks and reject/rebase stale context |
| Refresh/restart | Restore persisted investigation and accepted surface |
| Cancelled run finishes late | Ignore late publications to current state |
| Prompt injection in ticket | Treat it as data and preserve tool restrictions |

Proposed acceptance thresholds, to validate rather than claim in advance:

- All displayed headline numeric claims resolve to valid evidence and deterministic calculations.
- Exact affected-account membership and ARR match the independent fixture for the regression scenario.
- At least two specialist tasks overlap in the broad investigation.
- Three paraphrases across three datasets, repeated three times: 27 live opening-query runs; at least 90% satisfy their scenario rubric.
- No invented major incident in quiet-day runs. Any unsupported headline financial claim is a release blocker even if the overall score passes.
- Five live full drill-down sessions complete without losing context.
- No company-data mutation across the suite.
- Proposed local latency targets: activity within two seconds, useful findings within 20 seconds, complete broad investigation within 60 seconds. Report median and p95 with model/provider details; adjust scope based on measurements, not hidden shortcuts.

Do not snapshot exact generated prose or layout as the primary success metric. Score factual correctness, evidence quality, useful follow-ups, and valid interactions. Replay of a saved result should be deterministic; fresh model reasoning need not produce identical output.

## 8. Operational details and recovery

Log structured events with thread, investigation, run, task, agent, tool-call, and evidence IDs. Record durations, retries, token counts, and typed errors. Log high-level task plans, never private chain-of-thought. Keep API keys out of logs.

Use three separate notions of recovery:

1. View replay: load accepted A2UI and findings without model calls.
2. Conversation continuation: run a new turn against persisted investigation context.
3. Interrupted execution recovery: mark interrupted tasks and explicitly retry safe read-only work within a fresh budget.

Do not promise exactly-once model execution. Use idempotent state writes, action deduplication, and immutable evidence to make retries understandable. Persist evidence before committing a finding that references it. Publish surfaces only after the referenced findings are saved.

## 9. Effort, dependencies, and first work package

Estimated total: 15–22 focused engineering days for one experienced engineer, plus contingency for renderer/provider integration and usability iteration. This is a planning estimate, not a delivery commitment. A convincing first complete path should appear before final hardening.

Critical path: M0 → M1 → M2 → M3 → M4 → M5 → M6 → M7. Once contracts are stable, dataset work and shell work can be developed independently, but neither should bypass the M0 integration gate.

The first implementation work package is M0 only: scaffold, one SQLite-backed MCP tool, one graph task, one A2UI workspace surface, one generated action, and one restart test. Its deliverable is a runnable proof plus pinned compatibility notes. That resolves the highest-risk integration assumptions before committing to the full runtime.

## 10. Technical references checked during planning

- [CopilotKit A2UI integration](https://docs.copilotkit.ai/generative-ui/a2ui): documents A2UI support and current v2 entry points. Dedicated workspace mounting and surface lifecycle still require the M0 spike.
- [AG-UI event concepts](https://docs.ag-ui.com/concepts/events): reference for lifecycle, tool, and state event handling.
- [MCP TypeScript SDK v2](https://ts.sdk.modelcontextprotocol.io/v2/): reference for client/server packages and transport implementation.
- [LangGraph JavaScript persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence): checkpointers retain thread state; in-memory persistence does not survive process restart. Verify the concrete persistent adapter against pinned packages in M0.

These references establish integration direction, not a tested version matrix. Record exact installed versions and smoke-test evidence during implementation.
