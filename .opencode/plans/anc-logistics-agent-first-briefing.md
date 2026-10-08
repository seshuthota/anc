# ANC logistics: agent-first morning briefing (one clear thing at a time)

Branch: `logistics` @ `a51bda5` ("Rebuild the workspace around an Indian parcel network").
Basis: static reading of the clone at `/workspace/anc-logistics`, plus read-only runs on 2026-10-08:
`pnpm typecheck` (passes), `pnpm test` (97 tests pass: contracts 19, runtime-storage 4, policy 9, logistics-db 6,
logistics-mcp 12, agent 47), a fixture-mode briefing probe through `runInvestigation`, direct SQL against the seeded
`hub-fault` DB, and `pnpm test:e2e` (**1 of 3 pass**, see §2.7). The live model path was **not** run because there is no API key on this box.
This file is a plan. It implements nothing.

---

## 1. Goal

When the COO (or any persona) opens the workspace, or asks "what should I care about this morning?", the agents
investigate, reconcile, and rank behind the scenes. The surface then shows **one primary finding** that is
crisp and backed by evidence, offers **at most 3 next actions that really do something**, and keeps everything else
collapsed or out of sight. Follow-ups **evolve that surface in place** and do not pile up tiles. Every number on screen is
defined (metric, window, denominator) and opens its evidence in one click. No two numbers on screen contradict each other.

North-star alignment (`idea.md` §1, §10, §29, §35): tiny shell, no business routes, orchestrator plus MCP specialists,
shared evidence state, a UI Composer with no DB access, and A2UI only. This plan adds budget, reconciliation and action
round-trips on top of that architecture. It does not add a new dashboard.

---

## 2. Current-state diagnosis (evidence-backed)

### 2.1 Repo map
- `apps/web`: Next 15 shell. The single page is `app/page.tsx` (446 lines). A2UI mount is `lib/a2ui.tsx`, the catalog is `lib/catalog.tsx`, and SSE helpers are `lib/agent.ts`.
  `app/api/copilotkit/route.ts` is an *optional, unused* CopilotKit→`/ag-ui` proxy (comment at lines 4-5). `@copilotkit/react-core`
  is a dependency (`apps/web/package.json:17`) but nothing imports it. Only `@copilotkit/a2ui-renderer@1.73.0` is used (`lib/a2ui.tsx:4`).
- `apps/agent`: hand-rolled HTTP+SSE server (`src/server.ts`), LangGraph graph (`src/graph.ts`), planner (`src/planner.ts`),
  specialists (`src/specialists/live.ts` and `fixture.ts`), Lead Analyst (`src/synthesis.ts`), UI Composer (`src/ui-composer.ts`, which uses
  the model) over the template composer (`src/composer.ts`), operations (`src/operations.ts`), and runtime/state (`src/runtime.ts`).
- `apps/logistics-mcp`: the MCP server with 16 tools (`src/tools.ts`). 15 are reads and 1 is a write (`commit_complaint_assignment`, lines 274-284).
- `packages/logistics-db`: schema and deterministic seed (`src/seed.ts`). Scenarios are `hub-fault` (default) and `quiet-day`. The clock is Mon 21 Sep 2026 07:00 IST.
- `packages/contracts`: zod contracts for findings, metrics, evidence, actions, A2UI, presentation and catalog lists.
- `packages/policy`: personas, grants and redaction. `packages/runtime-storage`: runtime SQLite (evidence, findings, surfaces, proposals, operations).
- `docs/`, `idea.md`, `.opencode/plans/implementation-completeness-audit.md`: mostly the **old SaaS scenario** (§2.8).

### 2.2 A2UI / AG-UI / CopilotKit wiring
- **Emission:** `graph.ts composeNode` (248-306) → `toPresentation` (379-470) → `ui-composer.ts composeSurface` (224-283).
  In fixture mode it returns the template from `composer.ts composeA2UI` (20-264). In live mode the model authors a tree that `review()` checks
  (131-196) and falls back to the template after 2 rejections. Messages are A2UI v0.9 `createSurface/updateComponents/updateDataModel`.
  They are saved as a full surface revision (`graph.ts:285-298`) and streamed to the browser inside `STATE_SNAPSHOT.snapshot.surface`
  (`runtime.ts:128-137`). This is AG-UI-*named* events over a custom SSE (`server.ts:89-102,315-351`), not the CopilotKit runtime.
- **Catalog:** the basic set is Text/Column/Row/List/Card/Divider/Button, plus extensions Stat, Sequence, Table, Chart, SelectOption and EditField
  (`packages/contracts/src/catalog.ts:18-35`, `apps/web/lib/catalog.tsx:47-106`). The model may author only basic components plus Stat and Sequence
  (`catalog.ts:38`). Table/Chart/form are protected runtime blocks (`ui-composer.ts:44-52`). The renderer *also* ships the
  A2UI basic `Modal`, `Tabs`, `CheckBox` and `ChoicePicker` (seen in `node_modules/@copilotkit/a2ui-renderer/dist/.../catalog/basic`) because
  `includeBasicCatalog: true` (`catalog.tsx:318`), but the contracts list does not allow them.
- **UI → agent:** an A2UI `userAction` reaches `A2UIWorkspace.handle` (`lib/a2ui.tsx:47-57`), then `page.tsx invoke()` (231-271).
  `show_evidence` goes to a REST GET of the **first** evidence id only (233-237). `investigate` becomes a brand-new typed question (240-243).
  Anything else goes to `POST /runtime/actions` → `runtime.ts handleAction` (321-382), which is validated by `SemanticActionSchema`,
  deduped, and checked for stale surfaces (337-342).

### 2.3 Hierarchy, Lead Analyst, Composer rules, evidence store
- Graph: `plan → execute → synthesize → compose` (`graph.ts:342-354`). There is one round, and each briefing runs all 4 specialists in parallel
  (`planner.ts:149-155`, questions at 39-44).
- Lead Analyst (`synthesis.ts`) returns `{headline, steps(≤6), separate(≤4)}` (lines 12-16, 31-41). It does **not** pick a primary
  finding, rank, or reconcile numbers. It only checks that figures appear somewhere in the findings JSON (48-52). It is **skipped entirely in
  fixture mode** (line 102).
- Contradiction handling is just a log line: `noteContradictions` groups by free-text `metric.name` and emits
  "Contradictory X values remain visible until resolved" (`graph.ts:228-246`). Nothing is reconciled or dropped.
- Composer limits: the briefing prompt says "at most five items" (`ui-composer.ts:77`), and the reviewer only rejects >9 Cards
  (line 193). The template path (fixture, or any live rejection) has **no budget at all**. It renders the synthesis, a metrics row of up to
  4 Stat tiles (`graph.ts:446`, `composer.ts:45-52`), **every finding** as a Card with body and "View evidence" (`composer.ts:67-78`), and
  limitations. In briefing mode the composer is given no actions (`ui-composer.ts:242`), and `toPresentation` always sets
  `actions: []` (`graph.ts:463`).
- DB access: the composer has none (`composer.ts` and `ui-composer.ts` import only contracts/openai). This is good, so keep it and add a grep gate.
  Note that `mcp-client.ts:49` and `logistics-mcp/src/server.ts:8` open the company DB **writable by default**, even for read-only specialists.
- Evidence store: the MCP envelope has `evidenceId = tool-<hash16>`, plus args, filters, `dataAsOf`, `result`, completeness and payloadHash
  (`tools.ts:21-32`). It is persisted in runtime-storage, and claims cite `evidenceIds` + `resultPaths` + `metrics`
  (`contracts/src/findings.ts:6-27`). `validateFinding` checks that metric values match the evidence path (`validation.ts:13-37`).
  `MetricSchema` has `name/value/unit/aggregation/window` but **no canonical metric id, scope, or denominator**.

### 2.4 Morning briefing end to end, and why it clumps
1. On load, `page.tsx openWorkspace` (220-229) auto-asks `"Brief me: what needs my attention this morning?"` (line 21) once per
   identity per browser session.
2. `fixturePlan`/`livePlan` treat it as broad (`planner.ts:32,118-122`), so 4 tasks run: network, shipments, last_mile, customers.
3. Each specialist returns up to 4 findings (`live.ts:52`), so there can be **up to 16 findings**. The Lead Analyst writes a chain of up to 6 steps plus up to 4 "separate" items.
4. `toPresentation` (graph.ts:394-402) flattens **every metric of every claim** into Stat tiles. It labels them with the model's
   free-text `metric.name`, with no definition, window or scope, takes the first 4 by severity, and marks high severity as red (`tone: danger`).
5. Composer: the live path gives up to 5 cards plus tiles plus a Sequence. The template path shows *all* findings as cards.
   **Nobody owns the decision of what is "the one thing".**

**Where 905 vs 218 comes from (verified against the seeded DB):**
- `summarize_at_risk_shipments` → `totals.atRisk = 905` means parcels promised today that are not on a truck, network-wide. All of them are at Hyderabad:
  595 unsorted + 310 sorted-not-loaded, out of 4,000 promised today (`tools.ts:163-174`). This is the Shipments Agent.
- `get_shipper_on_time` → `rows[shipper-003].atRiskToday = 218` (`tools.ts:234-254`). This is the Customers Agent. It is the **same metric, scoped to one
  shipper**, so it is a *subset* of the 905.
- Other numbers that can also appear: `parcelsWaitingToSort = 595` (Network, `tools.ts:100-106`), held-run parcels = 609 and
  short-loaded = 296 (route runs, `tools.ts:131-144`). 609 + 296 happens to equal 905 again, but the definition is different.
- So these are different scopes and different definitions, shown side by side as sibling red tiles with ad-hoc labels. The Lead Analyst's figure
  check (`synthesis.ts:48-52`) and the composer's literal check (`ui-composer.ts:149-156`) only verify that a figure *exists somewhere*.
  Neither checks that it is coherent with the figures around it.

**Fixture-mode baseline (probe run on this box, `hub-fault` scenario):** the title is **"Nothing needs your attention this morning"**, even though 905
parcels are at risk. The fixture specialist marks every finding `medium` (`fixture.ts:40`) and `toPresentation` treats "no high/critical"
as quiet (`graph.ts:429-434`). The surface has 60 components, 7 Cards, and 4 Stat tiles all labelled "records", with values like 8, 3, 4 and 1 (`fixture.ts:47`). There are 7 "View evidence"
buttons, and a spurious activity line, "Contradictory records values remain visible until resolved". So the deterministic path cannot
currently demo or test the briefing at all.

### 2.5 Activity panel, evidence, actions
- The activity rail is an always-visible 300px sticky sidebar (`globals.css:112,223`, `page.tsx:390-429`). Every specialist start,
  finish and finding title is a step (`graph.ts:178,218,220`). It sits next to "Previous views and run details" dev info (412-427).
- **Evidence is not one-click:** the button sends `evidenceIds[]`, but the shell fetches only `[0]` (`page.tsx:233`, `runtime.ts:344`). A metric tile
  has no evidence action at all (`composer.ts:50`). Only finding cards do (`composer.ts:76`). The drawer dumps raw envelope JSON in a `<pre>`
  (`page.tsx:432-443`), with no definition, no highlighted value and no path.
- **Actions:** the only real mutation is complaint assignment: `prepare_assignment → select_assignee → commit_assignment`. It has a
  proposal with a 15-minute expiry, an idempotency key, optimistic version and a receipt surface (`operations.ts:10-127`, `tools.ts:274-284`). It is reachable only from
  a complaints *table* row (`registry.ts:84`), never from the briefing. The planner refuses reroute/dispatch/redeliver/send
  (`planner.ts:34,106`). The external-write note connector exists but is disabled by default (`external-write.ts`, `.env.example`).
  `ActionNameSchema` still lists SaaS-era names: `inspect_release`, `inspect_financial_impact`, `show_affected_accounts`, `inspect_account`
  (`contracts/src/actions.ts:4-18`).

### 2.6 Follow-ups
- A follow-up is a *new* run with a new plan. Its surface replaces the old one (same `surface-${investigationId}`, revision+1,
  `graph.ts:261-262`), but it is composed from **this run's** artifacts only (`graph.ts:255-259`), so the briefing context is gone.
  While a follow-up is working, the previous answer is hidden (`page.tsx:329-331`). There is no partial `updateComponents`/`updateDataModel`. Every turn is a full rebuild.

### 2.7 Tests / evals present
- Unit/integration (vitest): `apps/agent/src/{logistics,http,ui-composer,a2ui-validate,deployment,provider}.test.ts`,
  `apps/logistics-mcp/src/tools.test.ts`, `packages/*/src/*.test.ts`. There are model test seams: `usePlanModel`, `useSynthesisModel`, `useComposerModel`.
- Playwright: `apps/web/e2e/smoke.spec.ts` (3 tests) with `playwright.config.ts`. It uses fixture mode, `channel: "chrome"`, ports 4110/3010,
  and needs `data/logistics.sqlite` to be seeded. **Run on 2026-10-08: 1 passed, 2 failed.** (a) `getByRole('heading', {name: 'DemoCo'})` is not found because the
  auto-briefing switches the page out of home mode. (b) The title regex `/Morning overview|Unassigned|Results|Incomplete answer/` received
  "Nothing needs your attention this morning".
- **No eval harness on this branch.** `docs/setup.md:33-35` and `docs/demo-scenario.md:33-34` cite `pnpm eval`, `eval:live`,
  `eval:live-fallback`, a 27-run rubric and a 66-cell matrix. None of these scripts exist (root `package.json`, `apps/agent/package.json`).
- Commands that work today: `pnpm install --frozen-lockfile` (better-sqlite3 needs `make` and `g++`, which I installed on this box), `pnpm logistics:seed`,
  `pnpm typecheck`, `pnpm test`, `pnpm test:e2e`, `pnpm investigate -- "<q>"`, `pnpm replay`.

### 2.8 Stale docs (SaaS release scenario)
- `docs/architecture.md:5` ("fictional B2B SaaS company", "support-ticket assignment"), `:24-26` (invoice aging, finance follow-up),
  `:45` (Reliability/Product/Customer + Finance ARR), `:49` (Finance failure).
- `docs/demo-scenario.md` is entirely SaaS: sync-v2 `release-2026-09-19-3`, ARR $2.1M, invoices, `pnpm db:seed`, `sync-regression`, clock 08:00Z.
- `docs/setup.md:5,28` (`pnpm db:seed` does not exist; the real command is `pnpm logistics:seed`), `:31-35` (non-existent eval scripts), `:48` (invoice aging, tickets).
- `docs/compatibility.md:11` (wrong catalog id and components TextField/Checkbox; the real ones are `WORKSPACE_CATALOG_ID`, EditField and SelectOption), `:14` (version 12.4.1).
- `docs/evaluation-results.md` (all SaaS numbers: ARR, invoices, 109 tests/19 files), `docs/implementation-plan.md:185,234,240`,
  and `idea.md` (Reliability/Product/Customer/Finance agents). The code also carries leftovers: `contracts/src/actions.ts` (above), `ui-composer.test.ts:5-28`
  (invoice fixture), and `a2ui-validate.test.ts:133` ("Release caused it").

---

## 3. Target UX: the morning briefing as a wireframe in words

```
┌───────────────────────────────────────────────────────────────────────────────┐
│ DemoCo ·  [ Ask about hubs, parcels, lockers, shippers…            ] [Ask]    │  ← tiny shell, one input
│                                               Mon 21 Sep 07:00 IST · Ready ●  │
├───────────────────────────────────────────────────────────────────────────────┤
│  PRIMARY FINDING (one card, full width)                                       │
│  Hyderabad sorter fault puts 905 of today's parcels at risk                   │  ← headline ≤ 12 words
│                                                                               │
│  905  parcels at risk today  ⓘ                                                 │  ← ONE number, clickable
│       Promised for delivery today, not yet on a truck · as of 07:00 IST ·     │     definition · window ·
│       of 4,000 promised today (22.6%)                                         │     denominator
│                                                                               │
│  Why it matters: wave-2 runs for 3 Hyderabad areas are held; Godavari     │  ← 1 sentence, audience-
│  Organics (key account) would fall below its 96% commitment.                 │     shaped (COO priorities)
│                                                                               │
│  Sorter belt B down 22:10 ─▶ sorting 30/h vs usual ~163 ─▶ 3 runs held ─▶ 905  │  ← cause chain, ≤ 3 hops,
│  [Observed] [Observed] [Inferred link]                                        │     each hop tagged
│  Confidence: High (2 of 3 links observed)          [ Evidence (4) ▸ ]         │  ← one-click drawer
│                                                                               │
│  [ Escalate belt fault to engineer ]  [ Notify Godavari Organics ]  [ Assign 11 late  │  ← ≤ 3 real actions
│                                                              complaints ]     │     (confirm step)
├───────────────────────────────────────────────────────────────────────────────┤
│  ▸ 2 lower-priority items · everything else is running to plan                │  ← collapsed by default
│      (expands to: "2 Chennai lockers full: 64 arrivals with no space today",  │     ≤ 3 secondary, each
│       "1 complaint needs an owner") each with [Look into this]                │     one line + 1 drill
├───────────────────────────────────────────────────────────────────────────────┤
│  ▸ How this was worked out · 4 agents · 9 lookups · 2.1 s                     │  ← quiet trace, collapsed
└───────────────────────────────────────────────────────────────────────────────┘
```

Behaviours:
- **One number** sits on the primary card. Any other figure (595 unsorted, 218 for shipper-003, 609 held) appears only inside
  the evidence drawer or a drill-down, labelled by scope (for example "of which 218 are Godavari Organics'").
- **Evidence drawer** opens from the number's ⓘ or "Evidence (n)", in a host-side drawer. It shows the metric definition, window,
  denominator, the exact value with its `resultPath` highlighted, tool, filters and `dataAsOf`, a human-readable excerpt of the top rows, tabs when there are several
  evidence ids, and raw JSON collapsed at the bottom. Nothing extra is computed or written by an LLM.
- **Actions:** clicking one does not run a new investigation. The **same surface** swaps the action row for an inline confirm card
  ("Escalate eq-hyd-0920 Sorter belt B to the Hyderabad hub engineer on call? This writes to the maintenance log. [Confirm] [Cancel]").
  Confirm runs the agent tool, which writes state, and the primary card then shows a receipt line ("Escalated 07:02 · receipt op-…").
- **Drill-downs** appear only when asked: "Look into this", a typed follow-up, or a click on a chain hop. The drill-down **replaces the body**
  under a slim context header ("From your briefing: Hyderabad sorter fault ▸ Back"). It does not add cards below.
- **Quiet day** (`quiet-day` seed): no primary card. Instead it shows one calm line, "Nothing needs your attention this morning. Checked: hubs, parcels, lockers,
  shippers, complaints", plus the collapsed trace.
- **Partial failure:** the primary card still renders. One muted line explains "Customers Agent could not finish, so key-account impact is not included".

---

## 4. Design rules to enforce in code

R1. **Lead Analyst ranks and picks exactly one primary.** The output is `{primaryFindingId, secondaryFindingIds(≤3), whyItMatters,
    chain(≤3 hops, each with kind and findingIds), confidence}`. The runtime validates it: ids must exist, figures must come from the findings, and the primary must have
    a reconciled metric. A **deterministic ranker** decides in fixture mode, and also when the model's answer is rejected. Ranking score =
    severity weight + priority match against `principal.preferences.priorities` (`packages/policy/src/index.ts:60,74,88,102,116`)
    + breadth (affected parcels, log-scaled) + root-cause bonus. Ties break by a fixed domain order.

R2. **Reconcile before render.** Every displayed metric carries a canonical `metricId` from a metric registry, a `scope`
    (network | hub | shipper | district | locker), a `window`, and an optional `denominator`. Group the metrics by (metricId, scope, window):
    - same value → merge, and union the evidenceIds;
    - different value → re-read both from evidence through `resultPaths`. If they still differ, **drop both from display** and add a
      limitation ("Shipments and Customers disagree on parcels at risk today (905 vs 902); not shown until resolved").
      Emit one activity line;
    - same metricId, child scope ⊂ parent scope → render the child only as an "of which" sub-figure, never as a sibling tile;
    - a metric with no registry mapping (free-text name from a model) → not eligible for the headline number. It may appear only in
      drill-down prose.

R3. **The UI Composer has a hard budget and no DB access.** A briefing surface contains exactly 1 `PrimaryFinding` block, at most 1
    `Collapsible` holding at most 3 secondary items, at most 3 action buttons (evidence buttons excluded), 0 free-standing `Stat` tiles, and 0
    free-standing finding cards. `review()` rejects violations, the model gets one repair attempt, and then the budgeted template is used. The composer
    receives the *briefing plan* (primary, secondary, actions), not the raw finding list. A CI grep gate requires that no file under
    `apps/agent/src/{composer,ui-composer}.ts` imports `@anc/logistics-db`, `mcp-client`, or `better-sqlite3`.

R4. **Every number links to evidence.** Each bound figure in the data model sits next to `{metricId, evidenceIds[], resultPath}`.
    The composer reviewer rejects a number path that has no sibling `evidenceIds`. The template wires an evidence action to every figure.

R5. **Follow-ups replace, not append.** One surface per thread, revisioned. A drill-down or action swaps the body region or patches the
    data model. "Back" restores the previous revision with the existing `restoreSurface` (`runtime.ts:284-300`).

R6. **Actions are proposals until confirmed.** They come from a typed action catalog with a grant check, entity binding chosen by the runtime
    (as today, `ui-composer.ts:258-265`), a proposal with expiry, an idempotency key, an optimistic version, an audit entry and a receipt.

---

## 5. Phased, vertical, demoable slices

Roles: **Coder** implements. **Reviewer** reviews the diff against the rules in §4 and checks scope creep. **Tester** runs the verification
commands on a clean seed and attaches output. **Shipping gate** means a slice merges only when every gate item is green. Each slice can ship
on its own and leaves `main` demoable.

Common setup for every Tester run:
```bash
cd /workspace/anc-logistics
pnpm install --frozen-lockfile          # box needs make + g++ for better-sqlite3
pnpm logistics:seed                     # hub-fault → data/logistics.sqlite
pnpm typecheck && pnpm test
```
Standard gate (G0, applies to every slice): `pnpm typecheck` passes, `pnpm test` passes, `pnpm test:e2e` passes (green from Slice 0 onwards),
the composer DB-isolation grep is empty, docs are touched where behaviour changed, and there are no new business routes in `apps/web/app`.

```bash
# composer DB-isolation grep (must print nothing)
git grep -n -E "logistics-db|mcp-client|better-sqlite3" -- apps/agent/src/composer.ts apps/agent/src/ui-composer.ts
```

### Slice 0: Truthful baseline: docs/scenario cleanup and baseline capture
- **Scope**
  - Rewrite `docs/demo-scenario.md` for the parcel network: hub-fault story, numbers 905/595/310/609/218/4,000, clock 07:00 IST, personas, and
    quiet-day. Fix `docs/setup.md` commands (`pnpm logistics:seed`, remove or mark the eval scripts "planned in Slice 6"). Fix `docs/architecture.md`
    (§Purpose, Planning, Main investigation, Failure behaviour), `docs/compatibility.md` (catalog id, component list, driver version) and
    `docs/evaluation-results.md`. Move the SaaS-era content to `docs/archive/` with a dated header. Add a banner to `idea.md` and
    `docs/implementation-plan.md` saying the scenario is now the parcel network.
  - Remove the stale action names `inspect_release`, `inspect_financial_impact`, `show_affected_accounts` and `inspect_account` from
    `packages/contracts/src/actions.ts`, after checking that nothing else uses them (`git grep`). Move the `ui-composer.test.ts` fixture and the `a2ui-validate.test.ts:133`
    text to parcel data.
  - Fix `apps/web/e2e/smoke.spec.ts` for the current shell: the auto-briefing on load, the wordmark button, and a title assertion of "non-empty h2". Leave the strict
    assertion for Slice 6.
  - Add `inspect` to `apps/agent/src/cli.ts`. It runs a question against a temporary runtime DB and prints surface stats as JSON: title, component
    count, Cards, Stats, Buttons, metric labels, contradiction activity lines and primary-finding presence. Commit baseline JSON files for
    `hub-fault` and `quiet-day` under `apps/agent/src/__fixtures__/baseline/`.
  - Add `apps/web/e2e/baseline.spec.ts`, which saves a full-page screenshot of the briefing to `test-results/` (the files are not committed, only attached to the PR).
- **Files:** `docs/*.md`, `idea.md` (banner only), `packages/contracts/src/actions.ts`, `apps/agent/src/{cli.ts,ui-composer.test.ts,a2ui-validate.test.ts}`,
  `apps/web/e2e/{smoke,baseline}.spec.ts`, `apps/agent/src/__fixtures__/baseline/*.json`.
- **Verification**
  ```bash
  git grep -n -i -E "saas|sync-v2|ARR|invoice|release-20|db:seed|pnpm eval" -- docs ':!docs/archive' README* || echo "clean"
  pnpm typecheck && pnpm test
  RUNTIME_DB_PATH=$(mktemp -u /tmp/anc-XXXX.sqlite) pnpm --filter @anc/agent exec tsx src/cli.ts inspect "Brief me: what needs my attention this morning?"
  pnpm test:e2e
  ```
- **Done:** docs describe the parcel network, the e2e run is 3/3 (or more) green, and the baseline JSON is recorded. It should show today's flaws: title "Nothing needs your
  attention", 7 Cards, 4 "records" tiles, and a spurious contradiction line.
- **Gate:** G0, plus the Reviewer confirms there are no behaviour changes outside tests/docs/CLI and that the stale-term grep is clean.

### Slice 1: Reconciliation and single-primary ranking (backend, fixture-testable)
- **Scope**
  1. **Metric registry** `packages/contracts/src/metrics.ts` with `MetricDefinition {id, label, definition, unit, scopeType, window:
     "today"|"last_hour"|"commitment_13d"|"now", denominatorId?, sources: [{tool, path, scopeFrom?}]}`. Initial ids:
     `parcels_at_risk_today` (summarize_at_risk_shipments `totals.atRisk`, denominator `totals.promisedToday`; get_shipper_on_time
     `rows[].atRiskToday` with scope shipper), `parcels_waiting_to_sort` (get_hub_status `rows[].parcelsWaitingToSort`, scope hub),
     `hub_sort_rate_last_hour` vs `hub_usual_sort_rate`, `route_runs_held_today`, `parcels_left_behind_today`,
     `shipper_projected_on_time_rate`, `locker_inbound_without_space`, `complaints_open_unassigned`.
     Extend `MetricSchema` (`contracts/src/findings.ts:7-15`) with optional `metricId`, `scope {type,id?}`, and `denominator {value, metricId?}`.
  2. **Fixture specialist realism:** add `headline` specs to `registry.ts` capabilities (metric source paths plus deterministic severity
     thresholds, for example atRisk > 0 → high, open equipment fault severity high → high, inbound_without_space > 0 → medium). Then
     `fixture.ts` emits real titles and metrics with `resultPaths` instead of "N records returned" (`fixture.ts:38-47`). This fixes the
     "Nothing needs your attention" false negative.
  3. **Live specialists:** map each live metric to a `metricId` from `(evidence.tool, resultPath)` through the registry. Do this deterministically in runtime code,
     not with the model (`live.ts` `validated()`/`toFinding()`).
  4. **`apps/agent/src/reconcile.ts`** implements R2. Output: `{metrics: ReconciledMetric[], conflicts, notes}`. Replace `noteContradictions`
     (`graph.ts:228-246`) and add a `reconcile` graph node: `execute → reconcile → synthesize → compose`.
  5. **`apps/agent/src/rank.ts`** implements R1 deterministically and produces a `BriefingPlan {primary, secondary(≤3), quiet, suggestedActions: []}`.
     Extend the Lead Analyst (`synthesis.ts`) contract with `primaryFindingId`, `secondaryFindingIds`, `whyItMatters`, `confidence` and a
     compressed `chain` (≤3). Review the result against the ranker's eligible set. On rejection, record the substitution and use the ranker.
  6. `toPresentation` (`graph.ts:379-470`) builds metrics **only** from reconciled metrics. It drops the `metrics.slice(0,4)` flattening
     (line 446) and the "quiet if no high" rule (429-434) in favour of `BriefingPlan.primary === undefined`.
- **Files:** `packages/contracts/src/{metrics.ts,findings.ts,index.ts}`, `apps/agent/src/{registry.ts,specialists/fixture.ts,specialists/live.ts,
  reconcile.ts,rank.ts,synthesis.ts,graph.ts}`, and new tests `apps/agent/src/{reconcile,rank}.test.ts` with fixtures
  `apps/agent/src/__fixtures__/briefing/{hub-fault-findings,conflict-905-vs-902,scope-905-vs-218,quiet-day}.json`.
- **Verification**
  ```bash
  pnpm --filter @anc/contracts test
  pnpm --filter @anc/agent exec vitest run src/reconcile.test.ts src/rank.test.ts src/logistics.test.ts
  RUNTIME_DB_PATH=$(mktemp -u /tmp/anc-XXXX.sqlite) pnpm --filter @anc/agent exec tsx src/cli.ts inspect "Brief me: what needs my attention this morning?"
  LOGISTICS_DB_PATH=/tmp/anc-quiet.sqlite pnpm --filter @anc/logistics-db seed quiet-day && \
    LOGISTICS_DB_PATH=/tmp/anc-quiet.sqlite RUNTIME_DB_PATH=$(mktemp -u /tmp/anc-XXXX.sqlite) pnpm --filter @anc/agent exec tsx src/cli.ts inspect "What should I care about this morning?"
  pnpm test
  ```
- **Done:** on hub-fault the primary is about Hyderabad, and its metric is `parcels_at_risk_today`, value 905, with a definition, a window and a denominator of 4,000.
  218 appears only as a shipper-scoped child. The conflict fixture drops both values and records a note. The quiet-day run has no primary. There is no "Contradictory records"
  line. Plan, reconcile and rank are deterministic across 5 repeated runs (same primary id pattern and the same numbers).
- **Gate:** G0, plus the Reviewer checks that the ranker and reconciler are pure functions (no I/O) and that the Lead Analyst cannot introduce a figure absent from the
  reconciled set. The Tester attaches the before/after `inspect` JSON.

#### Deferred from P1 review (TODO, not implemented in the P1 fix commit)
- [ ] **#6 R2 re-read:** on a conflict, re-read both values from stored evidence through `resultPaths` before dropping them (today the conflict is decided on the claimed values, which are already evidence-checked by `validateFinding`/binding).
- [ ] **#7 Containment by id:** child ⊂ parent is decided by scope *type* rank (shipper/hub under network). Check containment by id (e.g. hub-hyd's districts under hub-hyd, not under hub-blr) once hub/district hierarchies are in the registry.
- [ ] **#8 Title-regex heuristics in the ranker:** `rootCauseBonus`, the equipment hop and the account hop in `rank.ts` match titles with regexes. Replace with entity/capability-based signals (equipment entity, customers-domain commitment metric).
- [ ] **#10 Narrow-question density:** non-briefing questions still render every finding plus up to 4 reconciled tiles; apply a (looser) budget there too.
- [ ] **#13** (reviewer item 13; carried as-is, see the P1 review notes).

### Slice 2: Composer budget, primary-finding A2UI block, collapsed rest
- **Scope**
  1. Contracts: add `briefing` to `PresentationInputSchema` (`contracts/src/a2ui.ts:117-153`) as `{primary:{headline, metric:{metricId,
     value, label, definition, windowLabel, denominatorLabel, evidenceIds, resultPath}, whyItMatters, chain[≤3]{text,kind,evidenceIds},
     confidence}, secondary: max(3), quiet:{label, count}, actions: max(3)}`.
  2. Catalog: add extensions `PrimaryFinding` (a runtime-built protected block like `table_block`, so the model places it but cannot alter it) and
     `Collapsible {summary, child}` (authorable, expands on the client only, no agent round-trip). Register both in `contracts/src/catalog.ts` and
     `apps/web/lib/catalog.tsx`, with styles in `globals.css`. Keep the parity test in `a2ui-validate.test.ts` green.
  3. `composer.ts`: in briefing mode the template is `root = [primary_block, actions_row?, rest_collapsible?, limits?]`. Briefing mode
     shows no findings list, no metrics row and no Sequence outside the primary block.
  4. `ui-composer.ts`: add `primary_block` to `BLOCKS`. Extend `review()` with the R3 budget (exactly 1 primary, ≤3 action buttons, ≤1
     Collapsible holding ≤3 items, 0 free Stat or Card) and R4 (a figure path must have sibling `evidenceIds`). Update the prompt (lines 68-83): the briefing is
     "one primary plus a collapsed rest" instead of "at most five items". Send only the briefing plan as `data`.
- **Files:** `packages/contracts/src/{a2ui.ts,catalog.ts}`, `apps/agent/src/{composer.ts,ui-composer.ts,graph.ts}`,
  `apps/web/lib/catalog.tsx`, `apps/web/app/globals.css`, `apps/agent/src/{ui-composer,a2ui-validate}.test.ts`.
- **Verification**
  ```bash
  pnpm --filter @anc/agent exec vitest run src/ui-composer.test.ts src/a2ui-validate.test.ts src/logistics.test.ts
  RUNTIME_DB_PATH=$(mktemp -u /tmp/anc-XXXX.sqlite) pnpm --filter @anc/agent exec tsx src/cli.ts inspect "Brief me: what needs my attention this morning?"
  pnpm --filter @anc/web build
  pnpm test:e2e
  ```
- **Done:** the `inspect` output for hub-fault shows 1 PrimaryFinding, 0 free Stat, at most 1 Collapsible with at most 3 children, and at most 3 action buttons. New composer
  tests reject 2 primaries, 4 actions, a free Stat, and a number without evidence. The baseline screenshot is visibly calmer. The quiet day renders the calm line only.
- **Gate:** G0, plus a side-by-side screenshot review (baseline vs new) signed off by the Reviewer, and the composer grep gate is empty.

### Slice 3: One-click evidence drawer
- **Scope**
  - Add a server endpoint `GET /runtime/evidence/:id/explain?metricId=&path=` in `server.ts` next to lines 278-290, keeping the same grant check. It returns
    `{definition, window, denominator, value, path, tool, filters, dataAsOf, excerpt: {columns, rows≤10}, raw}`, built from the stored
    envelope and the metric registry. It is deterministic and uses no model.
  - Every figure's evidence action becomes `show_evidence` with `{evidenceIds, metricId, resultPath}`. `page.tsx invoke()` (231-238) fetches
    **all** ids and renders a drawer with tabs: definition header, highlighted value, excerpt table, and raw JSON in a collapsed `<details>`. Fix
    `runtime.ts:344` so it also accepts multiple ids. The drawer is a host component, so it does not bump the surface revision.
  - Decision to record: use a host drawer, not A2UI `Modal`. This keeps evidence out of the model-authored tree and preserves grants.
- **Files:** `apps/agent/src/{server.ts,runtime.ts}`, new `apps/agent/src/evidence-explain.ts`, `apps/web/app/page.tsx` (or extract
  `apps/web/lib/EvidenceDrawer.tsx`), `globals.css`, `apps/agent/src/http.test.ts`.
- **Verification**
  ```bash
  pnpm --filter @anc/agent exec vitest run src/http.test.ts
  pnpm test:e2e   # new spec: click 905 → drawer shows "Promised for delivery today" and highlights totals.atRisk
  ```
- **Done:** one click on the number opens its definition and the highlighted source value. Multi-evidence findings show tabs. The care-lead persona gets a 403
  on locker evidence.
- **Gate:** G0, plus the Reviewer confirms that no evidence payload is passed to the composer and that redaction (`redactForPrincipal`) still applies.

### Slice 4: Real actions on the surface, with a confirm step and state round-trip
- **Scope**
  1. **Action catalog** `apps/agent/src/action-catalog.ts`: `{id, label, appliesTo: entityType[], requiredGrant, tool, confirmText,
     sideEffect: "write"}`. The initial set fits the seed:
     - `escalate_equipment_fault` → new MCP write tool. It sets `escalated_at` and `escalated_to` on `equipment_events`, versioned (target: `eq-hyd-0920`).
     - `notify_shipper` → new MCP write tool. It inserts into a new `shipper_notifications` table with status `queued`. **Nothing is sent.** The receipt says
       "queued for account manager" (target: shipper-003, AM `emp-am-1`).
     - `assign_complaints` → reuses `commit_complaint_assignment` in bulk for the open late complaints tied to at-risk parcels (11 in the seed).
     - Explicitly out of scope: reroute, dispatch and redeliver, which stay refused (`planner.ts:34`).
  2. Ranker → `BriefingPlan.actions`: at most 3, chosen deterministically from the catalog by the primary's entities and the person's grants. The Lead Analyst may
     reorder them but cannot invent one.
  3. Generalise `operations.ts` into `prepareOperation` / `commitOperation`. `prepareComplaintAssignment` and `commitComplaintAssignment`
     become instances of it. They keep the proposal expiry, idempotency key, expected version and audit.
  4. Add `propose_action`, `confirm_action` and `cancel_action` to `ActionNameSchema`, and add handlers in `runtime.ts handleAction`.
     Propose saves a new revision of the **same surface** with an inline confirm block in place of the action row. Confirm runs the MCP write,
     then re-runs only the affected read tool (for example `list_equipment_events`) and patches the primary card with a receipt
     line. It does not replan.
  5. Safety: specialists' MCP clients open the company DB read-only (`LOGISTICS_DB_WRITABLE=false` for reads). Only operation clients get
     write access (`mcp-client.ts:49`, `logistics-mcp/src/server.ts:8`). Add the new tools to `TOOL_DOMAINS`/`WRITE_TOOLS`
     (`tools.ts:39-59`) and to the policy grants.
- **Files:** `packages/logistics-db/src/{schema.ts,seed.ts}`, `apps/logistics-mcp/src/tools.ts`, `packages/policy/src/index.ts`,
  `packages/contracts/src/actions.ts`, `apps/agent/src/{action-catalog.ts,operations.ts,runtime.ts,rank.ts,registry.ts,mcp-client.ts}`,
  `apps/agent/src/composer.ts` (confirm block), tests `apps/logistics-mcp/src/tools.test.ts`, `apps/agent/src/logistics.test.ts`.
- **Verification**
  ```bash
  pnpm --filter @anc/logistics-db test && pnpm --filter @anc/logistics-mcp test
  pnpm --filter @anc/agent exec vitest run src/logistics.test.ts src/http.test.ts
  pnpm test:e2e   # new spec: Escalate → confirm card → Confirm → receipt on primary card; double-click is idempotent
  ```
- **Done:** each of the 3 actions does propose → confirm → DB row changed → surface revision+1 with a receipt. A stale version is refused. A duplicate action id is a no-op.
  A persona without the grant never sees the button and gets 403 if it forges one. Reads cannot write.
- **Gate:** G0, plus a security review by the Reviewer (grant, idempotency, version, audit row present, no write reachable from a specialist), and the Tester
  shows the SQL before/after for each action.

### Slice 5: Follow-ups evolve the surface (replace, not append), and a quiet activity trace
- **Scope**
  - Turn classification in `planner.ts`, using the existing entity and priorIntent signals: `drill` (about the primary or secondary entities, or a
    "Look into this" click), `action`, or `new_topic`. For `drill`, keep the briefing plan in graph state, so the surface becomes a context header
    ("From your briefing: … ▸ Back") plus a drill body. For `new_topic`, start a fresh briefing plan. Pass the prior briefing through `GraphState`
    (`graph.ts:17-34`) instead of composing from this run's artifacts only (255-259).
  - While working, keep the current surface visible but dimmed (`page.tsx:329-331` hides it today). "Back" uses `restoreSurface`.
  - Activity: the rail becomes a collapsed `<details>` under the surface with one summary line (agent count, lookup count, elapsed time). Drop per-finding
    lines from the default trace (`graph.ts:218`) and keep them in dev details. Move dev info behind `?dev=1` only (`page.tsx:114,412`).
    Change the `.stage` grid (`globals.css:112`) to a single column.
- **Files:** `apps/agent/src/{planner.ts,graph.ts,composer.ts,ui-composer.ts}`, `apps/web/app/{page.tsx,globals.css}`.
- **Verification**
  ```bash
  pnpm --filter @anc/agent exec vitest run src/logistics.test.ts
  pnpm test:e2e   # new spec: briefing → "Look into this" → body replaced, still 1 primary/context header, Back restores revision N
  ```
- **Done:** after 3 follow-ups the DOM still has at most 1 primary or context header, and the surface revision has increased by 3. The trace is collapsed by default.
  No Card count grows across turns.
- **Gate:** G0, plus the Reviewer walks through a 3-turn demo script, recorded as a screenshot sequence.

### Slice 6: Briefing eval and Playwright smoke ("one primary, no contradictions, action round-trip")
- **Scope**
  - `apps/agent/src/eval/briefing.ts` (tsx script) with scripts `"eval:briefing"` (agent) and `"eval:briefing": "pnpm --filter @anc/agent eval:briefing"`
    (root). Assertions per run: exactly 1 primary on hub-fault and 0 on quiet-day; at most 3 secondary; at most 3 actions; every on-screen figure bound with
    `evidenceIds`; no two shown metrics share (metricId, scope, window) with different values; no parent/child scope siblings;
    headline figures ⊂ reconciled metrics; action round-trip mutates the DB and shows a receipt. Persona sweep: coo, hub-hyd, lastmile, accounts, care.
  - Modes: `fixture` is the CI default. It is deterministic and feeds recorded model replies through `usePlanModel`/`useSynthesisModel`/`useComposerModel`
    from `__fixtures__/model-replies/`. `live-strict` (`MODEL_PROVIDER=explabs MODEL_EXECUTION_MODE=live-strict EVAL_REPEATS=5`) reports a
    pass rate with no substitutions and is not a CI blocker until it is stable.
  - Playwright `apps/web/e2e/briefing.spec.ts`: one `[data-a2ui="PrimaryFinding"]`; no duplicate metric ids in the DOM; evidence drawer
    opens with a definition; Escalate → Confirm → receipt; follow-up replaces. Tighten `smoke.spec.ts` (the title must not be "Nothing needs
    your attention" on hub-fault).
- **Files:** `apps/agent/src/eval/*`, `apps/agent/package.json`, root `package.json`, `apps/web/e2e/*.spec.ts`, and `docs/evaluation-results.md`
  (new numbers only).
- **Verification**
  ```bash
  pnpm eval:briefing                                   # fixture, must be 100%
  MODEL_PROVIDER=explabs MODEL_EXECUTION_MODE=live-strict EVAL_REPEATS=5 pnpm eval:briefing   # report only
  pnpm test:e2e
  ```
- **Done:** the fixture eval passes 100% across all personas and both scenarios. Playwright is green. The live-strict number is recorded honestly in the docs.
- **Gate:** G0, plus `eval:briefing` is wired into CI (or the documented pre-merge checklist), and the docs report fixture and live results separately.

Suggested order: 0 → 1 → 2 → 3 → 4 → 5 → 6. Slices 3 and 4 can run in parallel after 2. Slice 6's harness skeleton can start alongside Slice 1
so that each slice adds assertions as it lands.

---

## 6. Risks and dependencies

- **CopilotKit / A2UI versions.** `@copilotkit/a2ui-renderer` is pinned at `1.73.0`. It bundles a different `@ag-ui/client` than the workspace pin
  (`api/copilotkit/route.ts:10`). Custom extensions (PrimaryFinding, Collapsible) depend on `createCatalog`
  (`catalog.tsx:130`), and their behaviour on renderer upgrades has not been verified. Pin the version and keep the parity test. The "AG-UI" transport is custom SSE, not the CopilotKit
  runtime. Adopting CopilotKit chat or `useCopilotAction` is **not** needed for this plan. If the product wants it, treat it as a separate spike.
- **LLM nondeterminism.** The plan, Lead Analyst and composer are live models. Mitigate with deterministic ranking and reconciliation as the source of truth, review
  plus one repair plus a template fallback (already the pattern), recorded-reply fixtures for CI, and a separate live-strict eval that never substitutes silently
  (`provider.ts`, `execution.ts`).
- **Seed and metric semantics.** Several numbers coincide or overlap by construction: 905 at risk = 609 held + 296 short-loaded, and 905 ⊃ 595 unsorted
  ⊃ shipper subsets. Without the metric registry and scope rules, *correct* numbers still look contradictory. Shipper names derive from index
  formulas (`seed.ts:107-117`); shipper-003 = "Godavari Organics", Hyderabad usual sort rate ≈ 163/h (verified via SQL). `get_shipper_on_time onlyAtRisk` returns all 40
  shippers in the seed, because every shipper has at least 1 at-risk parcel. Ranking must use `wouldMissTarget`, not mere presence.
- **Fixture path is currently misleading** (§2.4). Until Slice 1 lands, fixture demos and tests say "nothing needs attention" on the fault day.
- **Action safety.** The new write tools mutate the demo SQLite only. `notify_shipper` must never send anything external (the receipt says "queued"). The
  company DB is writable by default today (`mcp-client.ts:49`). Fix that in Slice 4 before adding writes. There is no automatic undo, so each receipt must say
  so (as `operations.ts:146,171` already do).
- **Playwright environment.** It needs Google Chrome (`channel: "chrome"`), a seeded `data/logistics.sqlite`, and free ports 4110/3010. The box needed
  `make` and `g++` to build better-sqlite3. The smoke suite is red today, so it must be fixed in Slice 0 before it can serve as a gate.
- **Scope creep toward a dashboard.** Any PR that adds a free-standing tile, a second card in the primary region, or a business route fails the Reviewer
  check against R3/R5.
- **Docs drift.** The roadmap and audit docs claim eval suites that do not exist on this branch. Slice 0 must remove those claims, not paper over them.

## 7. Not verified

- The live-model briefing (the exact surface the PO saw at localhost:3000 with Lead Analyst and UI Composer active). No API key was available. The 905/218 diagnosis
  comes from code paths plus the seeded data, not from a live screenshot.
- Whether the A2UI basic `Modal`/`Tabs` render correctly through the themed catalog. They exist in the renderer bundle but were not exercised.
- `pnpm --filter @anc/web build` was not run (typecheck passed). `/api/copilotkit` was not exercised.
