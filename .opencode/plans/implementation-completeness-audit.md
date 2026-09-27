# DemoCo implementation-completeness audit

## Goal and non-goals

**Goal.** Produce a durable, claim-by-claim inventory of what the current DemoCo workspace implements, what is actually exercised, and what remains pending. Capture the audit at a named revision and working-tree state, then classify every material P0–P7 and security requirement as **implemented and tested**, **implemented but not freshly verified**, **partially implemented**, **documented but absent/weak**, or **pending**.

**In scope.** `apps/agent`, `apps/company-mcp`, `apps/web`, `packages/*`, all relevant unit/integration/HTTP/browser tests, package scripts and environment configuration, the seeded-data boundary, and `docs/implementation-plan.md`, `docs/architecture.md`, `docs/evaluation-results.md` (plus setup/demo/compatibility docs for cross-checking).

**Out of scope.** No application, test, documentation, configuration, database, or fixture changes. No feature implementation or repair during the audit. Do not infer completion from roadmap checkboxes, prose, generated `.next` output, existing SQLite files, or historical test-result artifacts.

**Planning snapshot.** This repository currently has a dirty worktree with many modified and untracked source files; the observed `HEAD` was `80ba0e2`. The audit must capture its own revision and full working-tree inventory rather than attributing the tree to that commit.

## Source-of-truth order

Use this order when sources disagree:

1. **Captured working tree:** current source, package manifests/lockfile, and explicitly named environment behavior at the audit start. Capture both tracked diffs and untracked files.
2. **Direct automated evidence:** tests run during this audit, with command, exit status, environment, revision, and sanitized output. A test file's existence is not a passing result.
3. **Direct runtime evidence:** fresh HTTP/SSE, MCP, CLI, and browser traces using controlled temporary databases. Runtime traces outrank stale reports when they are reproducible.
4. **Static integration checks:** import/call-graph, schema/registry comparisons, and source searches that establish how a path is wired; label these as static, not behavioral.
5. **Documentation:** `docs/implementation-plan.md` (updated 2026-09-23) and `docs/evaluation-results.md` (updated 2026-09-20) define intent and historical claims, not current proof. The implementation plan explicitly says its tests/browser/live runs were not rerun for that update; the evaluation report contains historical fallback-assisted results.

Ignore `node_modules/`, `.next/`, `test-results/`, `.vite/vitest/results.json`, WAL/SHM files, and pre-existing SQLite contents as implementation evidence. Never record `.env` values or API credentials; inspect only variable names, presence, and redaction behavior.

## Evidence and status rubric

Create one row per atomic claim, not one row per roadmap phase. Each row records: claim ID/phase; requirement; source path and symbol (line numbers are supplementary); test path and command; run timestamp/revision/environment; observed output or trace; limitations; status; and the smallest next proof. Split a requirement when only part of it is met.

- **Implemented and tested (I&T):** a current implementation path exists and a fresh, relevant test or runtime/browser observation exercises the requirement, including the claimed boundary—not merely a neighboring happy path.
- **Implemented but not freshly verified (I/NV):** source exists (and may have an old test), but the relevant behavior was not rerun in this audit or only a stale/indirect result exists.
- **Partially implemented (P):** some path exists, but required contracts, edge cases, fidelity, isolation, persistence, or interaction coverage is missing.
- **Documented but absent/weak (D/W):** documentation makes a stronger claim than the source/tests support, or only a narrow/stub-like implementation exists. Do not count as complete.
- **Pending (Pending):** no implementation or no executable evidence sufficient to support the requirement. Open roadmap items remain Pending until proven; an unchecked box is not the only basis for this status.

If evidence conflicts, retain both observations, prefer fresh direct behavior for the current-state classification, and open a risk item. Do not upgrade a status because a test passes in a mocked seam while the real transport/provider/UI path is unverified.

## Files likely to be touched

- **Writable in this planning task:** only `.opencode/plans/implementation-completeness-audit.md`.
- **Read-only audit inputs:** `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `.env.example` (never `.env` values), `apps/*/package.json`, all `apps/*/src`, `apps/web/app`, `apps/web/lib`, `apps/web/e2e`, and `packages/*/src` plus their tests.
- **Ephemeral verification artifacts:** use a unique directory under `/tmp/opencode/anc-audit/<timestamp>/` for sanitized command logs and temporary SQLite databases. Do not write application data, backups, reports, or snapshots into the repository.

## Ordered audit slices

Each slice ends with a short evidence review and an updated claim ledger; do not carry an unverified result into the next slice.

### Slice 0 — Freeze the audit baseline and denominator

**Read:** root scripts/lockfile, all package manifests, source/test file inventory, the three required docs, and the worktree state.

**Collect exactly:** commit/revision, `git status --short`, tracked diff names, untracked names, Node/pnpm versions, installed package versions, script-to-test mapping, database paths, and the date/freshness of every prior result. Build a complete file inventory excluding generated/dependency/data artifacts. Define the denominator: every atomic requirement in the audit matrix, not every checkbox.

**Evidence output:** a sanitized baseline manifest plus a list of requirements that cannot yet be judged. No phase status is assigned in this slice.

### Slice 1 — P0: execution modes and truthful transport

**Read:** `apps/agent/src/{provider,execution,planner,events,runtime,server}.ts`, `apps/agent/src/{provider,http,graph,planner}.test.ts`, `apps/agent/src/eval/*`, `apps/web/lib/agent.ts`, `apps/web/app/page.tsx`, `package.json`, and transport notes in the docs.

**Collect exactly:** fixture versus `live-strict`/`live-fallback` resolution; whether a fallback substitution is recorded and surfaced; actual `POST /runtime/investigate` and `/runtime/events` event order, run ID, progress, terminal/error behavior, and reconnect behavior; whether the browser actually consumes streaming lifecycle/state events rather than only a completed JSON response. Record the existing test names and which ones are fresh.

**Failure cases:** missing live credentials, model failure, timeout, malformed/partial response, and fallback reporting. Distinguish a test seam from a real provider run. Check for any silent fixture substitution.

### Slice 2 — P0: shell lifecycle and browser recovery

**Read:** `apps/web/app/page.tsx`, `apps/web/app/globals.css`, `apps/web/lib/{agent,a2ui}.tsx`, `apps/web/e2e/smoke.spec.ts`, `apps/agent/src/{runtime,graph,http}.test.ts`, and `docs/architecture.md`/the P0 exit gate.

**Collect exactly:** first visible progress, active-run identity, first-run cancellation, late-result suppression, refresh restoration, reconnect/in-flight recovery, persona-switch cleanup, history/restore, keyboard focus, and narrow-screen behavior. Record which browser assertions exist versus which require a manual browser trace. Do not call the current three-test smoke file coverage of forms, accessibility, or all persona flows.

**Review boundary:** conclude the transport/lifecycle slice only; do not infer planner or action completeness from a successful smoke test.

### Slice 3 — P1: identity, grants, sessions, and isolation

**Read:** `packages/policy/src/{index,session}.ts` and tests, `packages/runtime-storage/src/{schema,index}.ts` and tests, `apps/agent/src/{server,runtime,http-guard}.ts`, `apps/agent/src/deployment.test.ts`, web auth routes under `apps/web/app/api/auth`, `apps/web/lib/server-auth.ts`, and the P1 requirements.

**Collect exactly:** persona/grant/field matrix; trusted principal versus model-controlled arguments; demo header behavior; OIDC discovery, PKCE, signed session/hop, expiry/tamper checks, and startup refusal on missing production settings; owner/organization checks for state, streams, evidence, surfaces, actions, and restore; revocation, retention, and erasure effects. Exercise direct IDs and restored history, not just UI hiding.

**Evidence:** policy/session unit tests, deployment tests, and fresh HTTP probes under demo and OIDC-configured-but-unmapped modes. If no real issuer is configured, record real sign-in and multi-user pilot behavior as Pending/D/W rather than simulated success.

### Slice 4 — P2: capability and specialist registry over MCP

**Read:** `packages/contracts/src/*`, `packages/policy/src/index.ts`, `apps/agent/src/{registry,mcp-client}.ts`, `apps/company-mcp/src/{server,tools}.ts` and tests, `packages/database/src/*`, `apps/agent/src/{registry,unseen-capability,specialists/index}.test.ts`, and the P2 exit gate.

**Collect exactly:** capability-to-tool-to-policy parity; actual MCP input schemas versus registry schemas; grants, specialist scope, side-effect class, and allowlist enforcement; evidence-envelope shape, pagination/completeness, typed errors, and data provenance; no arbitrary SQL; read/write database behavior; and coverage of invoice aging plus the unseen incident/maintenance capability. Search planner, composer, graph, and page for business-specific branches and record any hit.

**Evidence:** a fresh MCP integration run, independent seed/database checks, registry tests, and an actual new-capability request through the existing shell. “Registered” without a successful tool call and present surface is not I&T.

### Slice 5 — P3-A: capability-grounded planning

**Read:** `apps/agent/src/{planner,registry,provider,validation}.ts`, `apps/agent/src/planner.test.ts`, `apps/agent/src/eval/*`, `packages/contracts/src/{tasks,actions,entities}.ts`, and the P3 planning requirements.

**Collect exactly:** fixture scoring/keyword behavior versus live model behavior; authorized capability descriptions/schemas and user context sent to the model; sanitization of unknown domains/capabilities, writes, duplicates, and task count; explicit unsupported and clarification outcomes; input types, time/entity scope, budgets, and no fabricated capability. Inspect whether a model override test proves only the seam or an actual provider path.

**Evidence:** fresh finance/support/operations/cross-domain/denied/unsupported cases in fixture mode; live-strict with a separately identified provider/configuration when authorized; live-fallback only as a separate substituted result. Record planner validity, denial correctness, substitutions, and latency.

### Slice 6 — P3-B: orchestration, shared state, and recovery

**Read:** `apps/agent/src/{graph,runtime,events}.ts`, `apps/agent/src/specialists/*`, `apps/agent/src/validation.ts`, `packages/runtime-storage/src/*`, `apps/agent/src/{graph,http}.test.ts`, and the P3 exit gate.

**Collect exactly:** bounded scheduling/concurrency, dependency/acyclic handling, follow-up selection from resolved state, selected entities/periods, partial/failed/conflicting findings, clarification/unmet criteria, evidence-before-finding and surface-after-finding ordering, ownership, checkpoint/restart recovery, and active-run supersession. Verify tool calls and model inputs do not contain unauthorized fields.

**Evidence:** fresh graph/HTTP tests plus a disposable process restart and replay; inspect persisted runs/tasks/evidence/findings/surfaces/checkpoints by ID. A current in-memory or same-process result is not restart evidence.

### Slice 7 — P4: dynamic, validated, interactive A2UI

**Read:** `packages/contracts/src/a2ui.ts`, `apps/agent/src/{composer,a2ui-validate}.ts` and tests, `apps/web/lib/a2ui.tsx`, `apps/web/app/page.tsx`, `apps/web/e2e/smoke.spec.ts`, styles, and the P4 acceptance matrix.

**Collect exactly:** composition inputs are authorized typed artifacts rather than database access; catalog/version support; create/update/delete lifecycle; nested data bindings, references, cycles, size/depth limits, action bindings, and surface revisions; renderer support for every emitted component; table/queue/detail/comparison/metric/form/draft/receipt flows; “show as table” without a new tool call; selection/edit/focus/scroll/unsaved-input preservation; last-valid-surface recovery; and no executable generated HTML/JavaScript.

**Evidence:** validator/composer tests, browser interaction traces for at least comparison, queue/detail, and prepare/form, keyboard/narrow checks, and a source search for business-specific routes. Text-only or button-only output does not satisfy an interactive requirement.

### Slice 8 — P5: generated business action lifecycle

**Read:** `apps/agent/src/{operations,external-write}.ts`, `apps/agent/src/operations.test.ts`, `apps/company-mcp/src/tools.ts`, `apps/agent/src/runtime.ts`, `apps/agent/src/server.ts`, `packages/contracts/src/actions.ts`, `packages/runtime-storage/src/{schema,index}.ts`, and the P5 exit gate.

**Collect exactly:** read/prepare/commit separation; exact ticket/assignee/version/expiry/effect preview; eligible-owner retrieval; edit invalidation/regeneration; authorization and freshness recheck immediately before commit; persisted pending/succeeded/failed/unknown state; idempotency and duplicate prevention; stale/expired/tampered/replayed submissions; restart/retry reconciliation; receipt and affected-artifact refresh; and explicit no-rollback semantics.

**Evidence:** use a temporary seeded company database, snapshot relevant rows before/after, run the generated UI sequence and direct API adversarial cases, and record actual mutation. A happy-path test alone does not prove the full exit gate. Check whether the company DB is genuinely read-only outside the one declared write.

### Slice 9 — P6: generality, evaluation, and usability

**Read:** `apps/agent/src/eval/{suite,rubric,heldout}.test.ts`, `unseen-capability.test.ts`, `apps/web/e2e/smoke.spec.ts`, the acceptance matrix in `docs/implementation-plan.md`, and the evaluation report.

**Collect exactly:** what the current suite actually covers versus the target 4 personas × 3 task families × 3 paraphrases × 2 repeats; dataset and held-out prompt provenance/freeze evidence; fixture regression, live-strict, fallback-assisted, denial, injection, stale, timeout, and composer-fallback results; provider/model/config/sample size; strict rate, substitutions, latency, tokens, cost, and failed rows; capability growth without a bespoke route/planner branch; and browser coverage for streaming, identity, forms, history, cancellation, keyboard, and layout.

**Human evidence:** obtain completion, wrong turns, source comprehension, and disruptive-layout notes from at least four unfamiliar participants representing the four personas. This is not substitutable by automated tests; until supplied, it remains Pending.

### Slice 10 — P7 and cross-cutting security/operations

**Read:** `apps/agent/src/{server,http-guard,connectors,external-write,usage,metrics,backup-cli}.ts`, `apps/agent/src/deployment.test.ts`, policy/session files, runtime-storage backup/retention code, `.env.example`, setup/architecture docs, and the P7 exit gate.

**Collect exactly:** OIDC-required startup/config, secret non-disclosure, session/hop and origin/CORS policy, request body/rate limits, tenant/owner enforcement, audit access, revocation/retention/deletion propagation, SQLite backup and restore, cost/budget unknown-vs-known behavior, connector health/latency, external-read principal/token boundary, external-write enable/host/principal/idempotency/unknown-outcome behavior, and no company mutation outside declared operations. Inspect SSRF/URL validation, secret logging, audit-token handling, and recovery behavior even where no current test exists.

**Evidence:** deployment tests, static security review, health/curl probes, and disposable backup/restore and connector mock tests. A configured code path without a fresh test is I/NV; no real customer/IdP/connector means production pilot remains Pending.

### Slice 11 — Reconcile and publish the audit

Cross-check every ledger row against source, fresh evidence, and the three required docs. Flag contradictions (for example, documented read-only behavior versus a declared company write, or roadmap completion versus current source). Count statuses only over the explicit requirement denominator, list all stale/unverified evidence, and identify the smallest next proof for every P/D/W/Pending item. No implementation or test change is permitted during reconciliation.

## Verification commands (delegated later to a tester)

These commands are deliberately not run in the planning task. The tester should run them in a disposable working copy or with isolated database paths, capture exit codes and sanitized output under `/tmp/opencode/anc-audit/<timestamp>/`, and record the revision/environment beside each result.

### Baseline and static checks

```bash
set -o pipefail
AUDIT_TMP="/tmp/opencode/anc-audit-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$AUDIT_TMP"
git rev-parse HEAD | tee "$AUDIT_TMP/revision.txt"
git status --short | tee "$AUDIT_TMP/status.txt"
git diff --name-status | tee "$AUDIT_TMP/tracked-diff.txt"
git ls-files --others --exclude-standard | tee "$AUDIT_TMP/untracked.txt"
node --version | tee "$AUDIT_TMP/node.txt"
pnpm --version | tee "$AUDIT_TMP/pnpm.txt"
find apps packages -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.json' \) \
  -not -path '*/node_modules/*' -not -path '*/.next/*' -not -path '*/test-results/*' | sort > "$AUDIT_TMP/files.txt"
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test
```

Treat `pnpm test` as one aggregate result, not proof for every package. Also run the relevant package tests separately so a failure can be attributed:

```bash
pnpm --filter @anc/database test
pnpm --filter @anc/company-mcp test
pnpm --filter @anc/runtime-storage test
pnpm --filter @anc/policy test
pnpm --filter @anc/agent test
```

For requirement-level attribution, run the agent files directly, for example:

```bash
pnpm --filter @anc/agent exec vitest run \
  src/provider.test.ts src/planner.test.ts src/registry.test.ts \
  src/a2ui-validate.test.ts src/graph.test.ts src/http.test.ts \
  src/operations.test.ts src/deployment.test.ts src/unseen-capability.test.ts \
  src/eval/suite.test.ts src/eval/heldout.test.ts
```

### Deterministic runtime, CLI, and evaluation

Prepare isolated fixtures before invoking the agent; do not reuse the checked-in `data/` databases for a mutation test.

```bash
COMPANY_DB_PATH="$AUDIT_TMP/company.sqlite" \
RUNTIME_DB_PATH="$AUDIT_TMP/runtime.sqlite" \
MODEL_PROVIDER=fixture MODEL_EXECUTION_MODE=fixture \
pnpm db:seed

COMPANY_DB_PATH="$AUDIT_TMP/company.sqlite" \
RUNTIME_DB_PATH="$AUDIT_TMP/runtime.sqlite" \
MODEL_PROVIDER=fixture MODEL_EXECUTION_MODE=fixture \
pnpm investigate -- "What should I care about this morning?"

COMPANY_DB_PATH="$AUDIT_TMP/company.sqlite" \
RUNTIME_DB_PATH="$AUDIT_TMP/runtime.sqlite" \
MODEL_PROVIDER=fixture MODEL_EXECUTION_MODE=fixture \
pnpm eval
```

Run browser verification in a disposable copy where `data/company.sqlite` is freshly seeded, because the current Playwright configuration points at the repository-relative data path. Record browser/Chrome versions and the exact test output.

```bash
pnpm test:e2e
```

Run live evaluations only with explicitly approved out-of-band credentials, a recorded provider/model/base URL (redacted), and a spending limit. Never print the key or source `.env`; run strict and fallback as separate experiments.

```bash
MODEL_PROVIDER=explabs MODEL_EXECUTION_MODE=live-strict \
EVAL_REPEATS=3 pnpm eval:live
MODEL_PROVIDER=explabs MODEL_EXECUTION_MODE=live-fallback \
EVAL_REPEATS=3 pnpm eval:live-fallback
```

The current 3-scenario × 3-paraphrase × repeat loop is not automatically the 72-case P6 target; record that sample-size gap. If credentials, a real issuer, a customer system, or human participants are unavailable, record the exact blocker instead of substituting fixture evidence.

### HTTP, deployment, and recovery probes

With a fixture agent started against the isolated databases, capture `/health`, allowed/disallowed origin, unauthenticated OIDC behavior, state/evidence/stream isolation, cancellation, retention/revocation, connector-disabled behavior, and backup/restore responses. Use `curl -i` or equivalent and save only redacted bodies/headers. Verify the company-row checksum before and after the declared ticket-assignment flow; do not treat a test that only checks a count as proof of no mutation.

The tester should also run `pnpm --filter @anc/web build` (or record a reproducible build failure) and the existing web typecheck separately from the agent/package checks.

## Risks and open questions

- The working tree is dirty and contains untracked implementation files; commit-level attribution and reproducibility are unresolved until Slice 0 captures it.
- Existing tests share process-global environment variables and some seed or mutate the default company database; parallel runs and stale state can produce misleading results.
- The roadmap/evaluation report contains historical and explicitly non-rerun results; the 9/9 live figure is fallback-assisted and must never be reported as live-strict.
- No production OIDC provider, customer connector, or human usability study is configured/supplied; those paths cannot be declared complete from local mocks.
- “Tested” must be defined per layer: unit, real MCP, HTTP/SSE, browser, restart, and live-provider evidence are different confidence levels.
- Current source/docs may disagree about read-only company access, write semantics, transport ownership, or implemented UI capabilities; resolve by fresh direct evidence and record the discrepancy.
- The local A2UI adapter and pinned package behavior may not support every accepted catalog primitive; validate the actual installed versions rather than relying on protocol names.
- Security review needs explicit decisions on request-size limits, SSRF protections, secret/log handling, audit-token lifecycle, tenant scope, and retention completeness; absence of a test is not proof of safety.

## Concise final-report template

```markdown
# DemoCo implementation completeness audit

Snapshot: <commit> + <working-tree state> | Run date: <UTC> | Environment: <Node/pnpm/provider/browser>

## Summary
- Requirements audited: <N>
- I&T: <n> | I/NV: <n> | P: <n> | D/W: <n> | Pending: <n>
- Fresh test/browser/live runs: <commands and outcomes; stale evidence listed separately>
- Release judgment: <do not call complete; name blocking claims>

## Ledger
| ID / phase | Atomic claim | Status | Source evidence | Fresh evidence (command/run) | Gap or next proof |
|---|---|---|---|---|---|
| ... | ... | ... | path:symbol | command + result/date | ... |

## Unverified and contradictory evidence
- <roadmap/docs claim, stale result, or source/runtime conflict>

## Blockers and next smallest proofs
- <blocker> → <specific evidence needed>
```

The final report must show counts and denominator, not an unexplained completion percentage, and must preserve Pending/D/W items until their stated evidence is supplied.
