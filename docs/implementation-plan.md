> **Scenario note (2026-10-08):** The running product scenario is now an **Indian parcel network**, not the earlier B2B product-release demo described in older roadmap rows below. Architecture and shell principles in this roadmap still apply. Parcel demo details: [demo-scenario.md](demo-scenario.md). Historical companion docs live under [archive/](archive/).

# Agent-native enterprise workspace: implementation roadmap

Updated: 2026-09-28. Status: P0–P5 local slice is in the tree. The P4 gaps found in the 2026-09-23 review (dead `view` routing, no real table, no drafts, no trend or selection controls, a validator/renderer component mismatch, and dropped clarification requests) are closed, and the evaluation harness now runs a 66-cell acceptance matrix in addition to the morning-investigation regression. Live planning asks the model for a plan and then validates it; fixture mode remains the default. Authenticated sessions use OpenID Connect when `AUTH_MODE=oidc`. Deployment controls, grant revocation, retention, backups, cost reporting, and an external read/write connector are in the tree and stay inactive until their environment is set. No production identity provider or customer system is configured in this workspace. The four-person unfamiliar-user study is still open, and the acceptance matrix has never been run against a live model. Shared employee sessions and autonomous background work stay deferred.

This is the active roadmap. It supersedes the investigation-only scope in the [original specification](../idea.md). The previous plan is preserved in the [historical archive](archive/investigation-mvp-plan-2026-09-20.md); its completion markers are historical claims, not a fresh audit. The [architecture](architecture.md), [demo](demo-scenario.md), and [evaluation report](evaluation-results.md) describe the existing implementation rather than the full target below.

Basis: source inspection, the fixture test suite, and a fixture execution of the acceptance matrix on 2026-09-28. Live evaluations, browser flows, and the completeness audit were not rerun for this update.

## 1. Product objective

Build one enterprise workspace that any authorized employee can use to accomplish business tasks through natural language. Specialized agents use company tools/MCPs, collaborate through shared runtime state, and dynamically assemble the information, workflows, and interface appropriate to the user's intent, context, and permissions.

An operations head, finance head, support head, and COO use the same shell. Role informs relevance and defaults; it does not prescribe a dashboard or limit the user to one business domain. Permissions are separate, enforced constraints. A job title must not implicitly grant unrestricted access.

Investigation remains one regression scenario. The product also supports retrieving records, comparisons, preparing work, editing drafts, and executing permitted business operations. Generated UI must support interaction, not merely display an answer.

### Fixed foundation and generated experience

| Engineered foundation | Dynamically selected or generated |
| --- | --- |
| Identity, authorization, business tools and rules | Relevant capabilities and specialists |
| Shared shell, navigation, input, history, activity | Work plan, dependencies, clarification requests |
| Accessible reusable component catalog | Layout, bindings, controls, alternative views |
| Validation, persistence, operation policies | Drafts, proposed changes, contextual follow-ups |

Agents cannot invent unavailable capabilities. New business capabilities still require tools, schemas, and domain rules. The goal is to avoid a bespoke screen and orchestration branch for every task.

**Core success test:** add a capability through an MCP tool, metadata, specialist instructions, and permission policy. An unfamiliar user can use it through the existing shell without a task-specific frontend route or hardcoded planner branch. A new reusable component is acceptable when an interaction is genuinely new; record that separately from business-specific UI work.

## 2. Current implementation and gaps

| Area | Observed state | Required evolution |
| --- | --- | --- |
| Shell | Single Next.js page, input, activity, workspace, history | Preserve shared shell; add scoped sessions, user context, drafts |
| Planning | `graph.ts` uses keyword classification and predefined investigation questions | Capability-grounded model planning with deterministic validation |
| Specialists | Four fixed domains, MCP allowlists, live/fixture implementations | Configurable registry, actual tool schemas, bounded delegation |
| Results | Evidence and findings | Records, comparisons, drafts, requested inputs, action proposals and receipts |
| Composition | `composer.ts` emits a fixed metrics/findings/table/actions layout | Composition based on task and typed artifacts |
| Renderer | Local A2UI subset adapter | Verified protocol behavior and reusable interactive controls |
| Transport | Backend supports SSE; page awaits completed JSON | Consume lifecycle/state streams with reliable active-run identity |
| Persistence | Runtime SQLite, evidence, findings, runs, surfaces, checkpoints | Ownership, scopes, artifact/draft versions, durable action ledger |
| Identity | Page starts with `local-demo`; no authenticated principal in shown flow | Server-resolved identity and isolated sessions |
| Operations | Company data is read-only | Explicit prepare/commit lifecycle for selected write capabilities |
| Evaluation | Reported fixture 27/27; live 9/9 with fallback; earlier live-only 3/9 | Separate live ability, fallback recovery, permissions, interaction quality |

Keep the evidence ledger, deterministic calculations, MCP boundary, Zod schemas, persistent graph, action validation, and history. Extend incrementally rather than replacing the application wholesale.

The old plan marked model-selected planning complete despite current keyword routing. Treat new exit gates as requirements to demonstrate, not checkboxes inherited from that plan.

## 3. Target architecture and invariants

```text
Shared shell + trusted reusable component renderer
                    ↕ streamed events and user interactions
Session / identity / authorization boundary
                    ↓
Context resolver → capability discovery → planner → plan validator
                                                  ↓
                                    bounded specialist scheduler
                                                  ↕
                                    authorized MCP gateway
                                                  ↕
                                         business systems
                                                  ↓
                         validated artifacts, evidence, action proposals
                                                  ↓
                              UI composer → surface validator → shell

Scoped runtime storage: sessions, plans, tasks, artifacts, drafts,
evidence, surfaces, events, execution receipts, budgets, audit records
```

- Effective tool access is the intersection of user grants, specialist scope, and task constraints. Enforce it in code, not just prompts.
- Apply authorization to evidence lookup, history, caches, streams, checkpoint access, and tool calls. Hiding UI elements is insufficient.
- The composer receives authorized artifacts and registered actions. It cannot call business systems or execute generated code.
- Keep A2UI as the presentation protocol. Task/artifact contracts describe business data, not a competing UI protocol. Verify installed-package support during implementation rather than assuming newer SDK features.
- Shared state means agents collaborating inside an authorized task. It does not mean every employee shares all sessions. Start with private sessions; explicit sharing comes later.
- Keep observed data, deterministic derivations, model-authored drafts, and confirmed execution results distinguishable.

## 4. Contracts and state to introduce

These are proposed names, not existing APIs. Put shared schemas in `packages/contracts`, version persisted data, and supply migration adapters.

| Contract | Required information |
| --- | --- |
| Principal context | Organization/user IDs, grants, team/record scope, locale, timezone, policy version; server resolved |
| User preferences | Role description, priorities, presentation preferences; cannot grant access |
| Workspace session | Owner, organization, objective, active entities/time period, artifact/surface references, sharing policy |
| Capability definition | Stable ID/version, MCP tool/server, description, real input/output schemas, read/write class, required grants, limits |
| Specialist definition | ID, responsibilities, instructions version, capability scope, output schemas, budget |
| Work plan/task | Objective, success criteria, dependencies, capabilities, input/output references, budgets, clarification requirements |
| Workspace artifact | Versioned record set, metrics, comparison, finding, draft, proposal, or receipt; lineage and access scope |
| Interaction event | Session/run/surface revision, registered action reference, selected records/form values, request ID |
| Action proposal | Capability/version, exact targets/arguments, expected record versions, effect preview, expiry, policy requirements |
| Execution receipt | Durable operation ID, actor, operation, attempt/status, external receipt, before/after references, timestamps/errors |

Do not turn every record into a story finding. Preserve structured data, provenance, units, freshness, pagination/completeness, and explicit limitations. Keep large evidence payloads outside repeated model/checkpoint context.

## 5. Phased implementation backlog

### P0 — Truthful baseline and responsive shell

Dependencies: none. Estimate: 2–4 focused engineering days.

- [x] Run current tests/typechecks and record a reproducible baseline. Preserve existing behavior as a regression suite.
- [x] Separate fixture, live-strict, and explicitly enabled live-with-fallback modes in execution traces and evaluation reports. Strict mode never substitutes fixture answers.
- [x] Connect the page to one supported streaming transport. Decide whether CopilotKit is the actual browser bridge or AG-UI is consumed directly, then align documentation with the implementation.
- [x] Publish active run identity before long-running work; reconcile events by run/revision and show progress before completion.
- [x] Fix first-run cancellation, late-result suppression, reconnect, and refresh behavior. A cancelled/older run cannot replace a newer workspace.
- [x] Replace builder-facing shell language with business language; move protocol/debug details to a developer view.
- [x] Implement a real fixture-backed browser smoke flow. The root `test:e2e` currently references a web script absent from the web package.

Primary files: `apps/web/app/page.tsx`, `apps/agent/src/index.ts`, `runtime.ts`, `specialists/index.ts`, eval code, package scripts.

**Exit gate:** browser displays progress during execution, cancel works on the first run, refresh restores accepted state, and live reporting cannot conceal fixture substitution.

### P1 — Identity, user context, permissions, session ownership

Dependencies: P0. Estimate: 4–7 days.

- [x] Seed operations, finance, support, and COO personas with an explicit grant matrix: capabilities, records, sensitive fields, operations.
- [x] Add server-side principal resolution. A local-only persona switcher can simulate seeded users, but must be labeled and disabled outside demo mode.
- [x] Separate relevance preferences from grants; permit cross-domain requests when authorized.
- [x] Scope sessions, evidence, artifacts, surfaces, events, caches, and checkpoint namespaces by organization and owner/access policy. Stop relying on one default thread.
- [x] Enforce access at API endpoints and the MCP boundary. Pass trusted principal context separately from model-controlled tool arguments. Filter rows/fields before data reaches agents.
- [x] Check direct-ID access, restored history, and streaming reconnects. Clear private browser state when switching demo identities.
- [x] Migrate existing local-demo data to an explicit demo owner rather than exposing it to all users.
- [x] Integrate real authenticated sessions before multiple real users access deployed data. The identity provider is any OpenID Connect issuer (`OIDC_ISSUER`, client id, client secret, and `OIDC_SUBJECT_MAP`). `AUTH_MODE=oidc` ignores the demo principal header. The labeled switcher remains only for `AUTH_MODE=demo`.

Primary areas: new identity/policy modules, contracts, runtime API/storage/schema, MCP client/server.

**Exit gate:** two users independently use the same shell without session leakage; unauthorized records, fields, evidence, and surfaces stay inaccessible through both UI and direct APIs. The same broad prompt uses each user's relevant context.

### P2 — Capability and specialist registries

Dependencies: P1. Estimate: 3–5 days.

- [x] Discover actual MCP tool schemas and enrich them with trusted domain, grant, and side-effect metadata. Discovery does not authorize execution.
- [x] Supply models with real tool parameter schemas; replace the current generic object parameters in the live specialist loop.
- [x] Register the existing four specialists as configuration and instructions while retaining enforced scopes.
- [x] Select a bounded relevant capability subset for each request, rather than sending every tool to every specialist.
- [x] Validate registry entries against connected tools and versions; expose missing capabilities honestly.
- [x] Add one non-investigation read capability, preferably aging-balance comparison using existing billing data after a coverage audit.

**Exit gate:** the new capability works from its schema/metadata without a frontend route. Inaccessible tools are neither exposed to the model nor callable. Registry validation is tested independently.

### P3 — General planning and shared artifacts

Dependencies: P2. Estimate: 5–8 days.

- [x] Generalize investigation task/results to work tasks and typed artifacts, retaining compatibility with current fixtures and stored runs.
- [x] Replace keyword routing with structured plans using the user objective, authorized capabilities, and session context. Fixture mode scores the capability catalog and may schedule one finance follow-up after affected accounts are known. Live mode sends authorized schemas, user context, and the objective to the model, including that follow-up; the runtime validates, grants-filters, drops writes, caps tasks at three, and executes the result. Live-strict does not substitute the fixture planner. Live-fallback records the substitution.
- [x] Validate known capabilities, permissions, input types, acyclic dependencies, artifact references, and total task/tool/time/token budgets before scheduling.
- [x] Begin with at most three concurrent specialist tasks and bounded replanning. Runtime code owns scheduling; model text cannot create unlimited work.
- [x] Keep selected entities, explicit periods, relevant prior artifacts, and user edits into follow-ups. Resolve “these customers” from state.
- [x] Ask targeted clarification when required inputs or consequential ambiguities cannot be resolved. Return a clear limitation for unsupported tasks. A clarification is a distinct outcome: it is no longer rewritten into a permission denial, and a request the persona is not granted names the unavailable domain and the alternatives they do have.
- [x] Preserve partial outputs, conflicting evidence, missing data, and unmet success criteria. Show concise plans/progress, not private reasoning.
- [x] Keep deterministic plans in labeled fixture mode only; do not silently replace live planning.

Primary files: `graph.ts`, `runtime.ts`, specialist loop, new planner/registry modules, contracts/storage.

**Exit gate:** finance, support, and operations requests generate different valid plans; one cross-domain request coordinates specialists; an unsupported request stops honestly. Paraphrases do not require new routing branches, and follow-ups preserve scope.

### P4 — Dynamic interactive UI

Dependencies: P3; generic component preparation may begin after P2 contracts settle. Estimate: 5–8 days.

- [x] Replace fixed composition with a constrained composition step using the objective, authorized artifacts, interaction needs, and supported catalog. The view is chosen from the capabilities actually scheduled, so paraphrases converge without extra routing branches.
- [x] Build reusable record tables, detail views, comparisons, metric groups, time-series views, forms, selection/filter controls, draft previews, and action review controls as acceptance tasks require them. Tables sort by column with numeric ordering where the artifact supplies it and show tool-computed totals; time series render as an SVG chart; selection uses checkbox groups; drafts are editable with completion toggles.
- [x] Verify A2UI adapter behavior for nested data updates, surface lifecycle, event bindings, and form state. Prefer supported renderer behavior and document catalog extensions. `Table`, `TextField`, `Checkbox` and `Chart` are documented adapter extensions in `apps/web/lib/a2ui.tsx`.
- [x] Validate components, data paths, references, action bindings, size/depth, and cycles before rendering. Never execute generated HTML/JavaScript. The validator and renderer now share one component list, with a test that fails if the renderer stops handling an accepted type.
- [x] Use stable component/artifact IDs. Preserve selection, focus, scroll, and unsaved edits across updates; distinguish user input from regenerated defaults. Sort order, edited field text and checkbox state live in the adapter, not the data model, so a regenerated surface cannot discard them.
- [x] Provide readable source inspection with filters, timestamps, units, and limitations; keep raw JSON secondary.
- [x] Support "show this as a table" without losing context or unnecessarily querying tools again. A typed follow-up resolves against the last accepted surface's view and reuses the thread's stored artifacts.
- [x] Retain the last valid surface on failure. A disclosed generic artifact view is an acceptable recovery path, measured separately from successful composition.

Primary files: `composer.ts`, `a2ui-validate.ts`, `apps/web/lib/a2ui.tsx`, A2UI/artifact contracts, styles.

**Exit gate:** comparison, queue/detail, and draft/form tasks produce suitable interactive surfaces without business-specific routes. Users can select, edit, submit, revisit, and change presentation. Keyboard and compact-screen flows work; invented data and unregistered actions fail validation.

### P5 — Business actions through generated workflows

Dependencies: P1–P4. Estimate: 5–8 days.

First write: assign a synthetic support ticket to an eligible owner. This proves a real state change in an existing domain without adding external messaging or payment execution.

- [x] Add read/prepare/commit capability semantics. Reads remain automatic; confirmations follow operation policy and the user's existing authorization.
- [x] Prepare exact targets, changes, expected record versions, expiry, and effect preview on the server.
- [x] Generate an editable assignment form whose eligible owners come from a tool. Editing consequential fields invalidates or regenerates the bound proposal.
- [x] Recheck permissions, constraints, freshness, and any required confirmation immediately before commit. Bind confirmation to the exact proposal revision/parameters.
- [x] Persist action/idempotency state before issuing the write. Use stable operation keys with supporting tools; record pending, succeeded, failed, and unknown outcomes.
- [x] Reconcile uncertain outcomes before retrying. Do not promise exactly-once execution where the external system cannot provide it.
- [x] Display a receipt and refresh affected artifacts after success. Cancellation after commit does not imply rollback; reversal exists only where the underlying capability supports it.
- [x] Keep the read-only investigation fixture; add an independently resettable mutable scenario for operation tests.

Primary areas: action contracts, runtime action handling/storage, MCP tools, database migrations, form bindings.

**Exit gate:** an authorized user completes assignment through generated UI. Unauthorized, stale, expired, tampered, and duplicate submissions cannot cause unintended writes. Restart/retry reconciles operation state; failures and uncertainty are visible.

### P6 — Prove generality and usability

Dependencies: P0–P5. Estimate: 4–7 days plus participant scheduling.

- [x] Freeze held-out paraphrases and data variations before prompt tuning; run the acceptance matrix below.
- [x] Add one new business capability through registry/tool/policy changes. Record all code changes; investigate any bespoke page or routing branch needed. Two have been added this way since the last update: `list_open_incidents` and `get_service_health_series` (the service error-rate series behind the trend view). Neither required a frontend route or a planner branch; the series capability is reached by capability scoring and composes as a trend view.
- [x] Report live-strict quality separately from fixture regressions and fallback-assisted completion, including composer fallback.
- [ ] Verify browser flows for streaming, identity isolation, forms, history, cancellation, stale state, and keyboard use. The Playwright smoke still covers progress, cancel, refresh and the identity label only. Sortable table headers, draft editing, completion toggles and selection have unit and HTTP coverage but no browser assertions.
- [ ] Ask at least four unfamiliar participants representing the four personas to complete read, follow-up, and action tasks. Record completion, wrong turns, source comprehension, and disruptive layout changes.
- [x] Update architecture, setup, demo scenarios, and evaluation documentation with observed results and unmet gates.

**Exit gate:** workflows meet the quality thresholds below, and business capability growth does not require corresponding bespoke screens. Passing only the morning investigation is insufficient.

The fixture acceptance matrix passes 66/66 with no substituted runs, including 21 promised refusals. It has never been run live-strict, and no unfamiliar participant has used the workspace, so this gate is not met.

### P7 — Real organization pilot

Dependencies: P6 and real authentication from P1. Estimate after selecting systems/deployment.

- [x] Connect one read-only system through `EXTERNAL_READ_URL` with a server-held bearer token. Callers need `EXTERNAL_READ_PRINCIPALS`. Unconfigured stays unavailable. The token is not returned to the browser. No customer system is bundled.
- [x] Add deployment session security, tenant isolation, restricted origins, input/rate limits, secret management, retention, audit access, backups, and tested recovery. OpenID mode refuses to start without session secret, issuer, client credentials, subject map, origin allowlist, and audit token. `pnpm backup` snapshots the runtime and company databases.
- [x] Recheck grants on historical artifacts after revocation; propagate retention/deletion to evidence, derived surfaces, and checkpoints.
- [x] Establish pricing, budgets, connector health, latency, and error monitoring. Unconfigured cost is `unknown`, not zero. A USD budget is refused while the price is unknown. Token budget stops a live specialist loop.
- [x] External notes can be written only when `EXTERNAL_WRITE_ENABLED=true`, the host is allowlisted, and the principal is listed. The synthetic ticket assignment remains the company write. Duplicate keys do not send a second successful call. Unknown outcomes are not retried.
- [x] One external connector is the expansion point. Further connectors wait on a real task. Employee-to-employee shared sessions and autonomous background work stay deferred.

**Exit gate:** a small pilot group uses one workspace on real data with dependable access boundaries, observable failures, and recoverable operations.

## 6. Acceptance matrix

These are target scenarios. Audit existing data/tool coverage and implement missing capabilities during P2–P5.

| User/request | Work required | Useful generated interface |
| --- | --- | --- |
| Operations: service health and recent changes this week | Telemetry/releases with explicit period | Trend, timeline, scoped details |
| Accounts: compare overdue balances by shipper | Billing records and deterministic aging | Sortable table, totals, customer details |
| Support: unassigned escalations; assign one | Queue query, prepare/commit assignment | Queue, detail, assignment form, receipt |
| COO: customer problems requiring coordination | Authorized support/operations/finance synthesis | Prioritized cross-domain summary and sources |
| Any permitted user: “Only these customers, last month, as a table” | Resolve prior selection; change period/view | Updated view retaining context |
| Any user: draft customer onboarding checklist | Retrieve context; propose steps | Editable draft, explicit assumptions |
| Restricted user: inaccessible financial information | Enforce access before model exposure | Clear limitation; permitted alternatives |
| Any user: unavailable business operation | Detect missing capability | Honest limitation, no fabricated success |

Run “What needs my attention?” across personas as a relevance test, not the only shared-interface test. Ask the same explicit question from two authorized roles: underlying facts should agree even if emphasis differs.

## 7. Evaluation and release gates

### Deterministic correctness

All critical authorization, tenant/session isolation, numeric lineage, idempotency, stale-version, and tampering tests must pass. Unauthorized data must not reach model context, stream payloads, caches, restored surfaces, or evidence endpoints. Totals remain reproducible from independent fixture queries. Drafts cannot masquerade as observed facts or completed operations.

Validate malformed/cyclic UI graphs and unsupported actions. Test meaningful browser behavior rather than exact generated prose/layout snapshots.

### Live quality

Proposed P6 matrix: 4 personas × 3 task families (retrieve/compare, contextual follow-up, prepare/execute) × 3 paraphrases = 36 cases; repeat twice for 72 runs. Include allowed and denied requests with explicit expected outcomes. Add separate failure/adversarial cases for injection, unavailable tools, timeout, stale state, and interrupted commits.

The implemented fixture matrix is **66 cells per repeat**, slightly larger than the 36 above because most paraphrases are paired with both an allowed and a refused persona; 21 cells are promised refusals. `EVAL_MATRIX_REPEATS=2` gives 132 matrix runs. It has only been executed against the fixture path.

Target at least 90% live-strict end-to-end success on supported held-out cases. Any unauthorized disclosure/write or fabricated successful execution blocks release regardless of average score. These are targets, not current measured results.

Report planner validity, tool success, artifact correctness, useful UI completion, strict success, fallback frequency, denial correctness, clarifications, calls/tokens, and actual cost. Record provider/model/configuration and sample size. Correct denial counts only when expected by policy.

### Experience

Targets: first browser-visible progress within 2 seconds; first useful read result within 20 seconds where source latency permits; representative multi-domain read completion p95 under 60 seconds. Measure the browser experience, not only backend event timing. Preserve edits/selections; never silently lose drafts.

Distinguish saved-view replay, new-turn continuation, and interrupted execution recovery. Replay should not require a new model call. Report latency misses rather than masking them with deterministic answers.

## 8. Migration and implementation discipline

1. Preserve the existing investigation as a regression scenario.
2. Add versioned contracts and storage migrations before changing persisted payloads. Back up runtime data and test old-state loading.
3. Adapt legacy findings into artifacts, then migrate planner and composer independently.
4. Add ownership before expanding access or writes. Saved surfaces are not permanent authorization grants.
5. Ship small end-to-end slices: scoped read, materially different generated view, then one complete action lifecycle.
6. Keep deterministic business rules in tools/domain services. Prompts coordinate capabilities; they do not replace accounting rules, permissions, or invariants.

Avoid role-specific frontend routes, exhaustive task templates, unrestricted SQL, generated executable UI, a service per agent, and premature long-term-memory infrastructure. These do not solve the immediate product gaps.

## 9. Sequence, estimates, and first work package

Recommended order: P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7. Generic component work may overlap after contracts stabilize. Identity and execution boundaries precede real multi-user writes.

P0–P6 estimate: 28–47 focused engineering days for one experienced engineer, plus integration contingency and participant scheduling. These are estimates, not commitments. Validate a read-only general workspace after P4 before expanding operation scope. Estimate P7 separately once real integrations are selected.

Start with P0:

1. Establish reproducible checks and explicit live-strict/fallback modes.
2. Wire streaming progress and active-run identity into the shell.
3. Verify first-run cancellation, refresh/reconnect, and late-result handling in a browser.
4. Record one successful investigation and one visible partial/failure outcome.

Then deliver four local personas and isolated sessions in P1. The next product checkpoint is two users working independently in the same shell, followed by two substantially different tasks producing different interfaces through the common planner/composer.

| Decision | Planning default | Revisit |
| --- | --- | --- |
| Initial users | Four synthetic personas, private sessions | P1 before real authentication |
| First new read | Aging-balance comparison using seeded billing rows | P2 coverage audit |
| First write | Synthetic support-ticket assignment | P5 coverage audit |
| UI approach | Existing stack, A2UI, constrained reusable catalog | P4 integration verification |
| Agent deployment | Configurable specialists in one runtime | Only if scale/isolation requires change |
| Shared employee sessions | Deferred; explicit access design required | After P6 |
| Identity provider | OpenID Connect, issuer selected by environment | A hosted issuer is still required before a real deployment |
| External system | Read and optional note write, both disabled until URLs and secrets are set | When a real system is chosen |

The outcome is one coherent application whose capabilities grow through business tools and agent configuration, while the same clean interface adapts to different people and tasks.
