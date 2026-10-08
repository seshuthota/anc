# Evaluation results

Updated 2026-10-08 for the Indian parcel network scenario (`logistics` @ `a51bda5` and the agent-first briefing work through Slice 6). Human usability review is still open. **No live-model run has been performed on the parcel scenario**; every number below is the deterministic fixture path.

## Suites on this branch

| Suite | What it measures | Command |
| --- | --- | --- |
| Unit / integration | contracts, runtime-storage, policy, logistics-db, logistics-mcp, agent | `pnpm test` |
| Playwright | Fixture-backed shell: identity label, cancel, refresh; one primary, unique metric ids, evidence definition, inline confirm → receipt, follow-up replaces, hub table hours; P4/P5 flows; screenshots | `pnpm test:e2e` |
| Briefing eval | R1–R4 on every persona × scenario, review → repair with recorded replies, action round-trip | `pnpm eval:briefing` |
| CLI inspect | Temporary runtime DB; prints surface stats JSON for a question | `pnpm --filter @anc/agent exec tsx src/cli.ts inspect "…"` |

The older investigation rubric and 66-cell acceptance matrix scripts are **not present on this branch**.

## Briefing eval (`pnpm eval:briefing`)

Fixture and live results are reported separately. Fixture mode is the CI default and must be 100%.

What each cell checks (one cell = scenario × persona × variant):

- **R1, one primary.** A briefing plan exists; exactly one `PrimaryFinding` on `hub-fault` and none on `quiet-day`; the surface matches the plan; the `hub-fault` title is never the calm "Nothing needs your attention" line; on `hub-fault` the primary figure is pinned per persona (COO and accounts `parcels_at_risk_today`, Hyderabad hub `parcels_waiting_to_sort`, last mile `route_runs_held_today`, care `complaints_open_unassigned`).
- **R2, reconciled figures only.** Headline and why-it-matters figures are a subset of the reconciled figure gate; the primary figure is a headline-eligible reconciled metric with the same value; every shown figure is reconciled and not conflicted; no two shown figures share (metricId, scope, window) with different values; no parent/child siblings unless the child says "of the <parent>".
- **R3, budget.** At most 3 secondary items, at most 3 action buttons and 3 planned actions, at most 1 `Collapsible`, 0 free `Stat`, 0 `Card`, 0 `Sequence`; no operation buttons without a primary; every chain hop names the findings it cites, and none of them (nor the primary) is repeated as a lower-priority item.
- **R5, drills.** Each lower-priority item's drill asks about the row's own (scoped) title.
- **R4, evidence.** Every bound figure has `evidenceIds` beside it, including the primary metric, each chain hop and each secondary item.
- **Variants.** `deterministic` uses the ranker and the template composer. `replay` feeds hand-written model replies (`apps/agent/src/__fixtures__/model-replies/`, documented there as written, not recorded) through `useSynthesisModel` / `useComposerModel`. The first reply breaks the rules (an invented figure and finding id; a free `Stat` and a `Card`), so the cell also checks that review rejected it, the repair was used, and no Lead Analyst substitution was recorded.
- **Round-trip** (copy of `hub-fault`, COO): all three operations are offered; a forged propose from a persona without the grant is refused; for Escalate, Notify and Assign: propose → confirm → the company database row changed → a succeeded receipt on the same surface, stamped with the demo clock; the next briefing offers none of the done operations.

### Fixture results (2026-10-08, branch `agent-first-briefing`)

| Scenario | Personas | Variants | Cells | Checks |
| --- | --- | --- | --- | --- |
| hub-fault | coo, hub-hyd, lastmile, accounts, care | deterministic, replay | 10/10 | 259/259 |
| quiet-day | coo, hub-hyd, lastmile, accounts, care | deterministic, replay | 10/10 | 185/185 |
| round-trip | coo (hub-fault copy) | – | – | 12/12 |

Total: **20/20 cells (100%), 456/456 checks, round-trip pass.** Primary findings on `hub-fault`: COO and accounts "905 parcels at risk of missing today's promise", Hyderabad hub "Hyderabad Hub has 595 parcels waiting to sort", last mile "3 route runs held today", care "14 complaints need an owner". Every persona gets "Nothing needs your attention this morning" on `quiet-day`.

### Live results

**Not run.** `MODEL_PROVIDER=explabs MODEL_EXECUTION_MODE=live-strict EVAL_REPEATS=5 pnpm eval:briefing` needs a model key, and none was available where this branch was built. There is no live-strict pass rate yet; do not read the fixture numbers as one.

## Deterministic fixture suite (parcel)

| Suite | Result |
| --- | --- |
| `@anc/logistics-db` seed, hub-fault / quiet-day | pass (see package tests) |
| `@anc/logistics-mcp` evidence envelopes, tools | pass |
| `@anc/runtime-storage` evidence persistence | pass |
| `@anc/policy` grants, field redaction, session isolation | pass |
| `@anc/contracts` evidence/action/A2UI/presentation schemas | pass |
| `@anc/agent` logistics / HTTP / composer / A2UI validation | pass |
| Workspace typecheck | pass |
| Playwright fixture suite | pass (see `pnpm test:e2e`) |
| Briefing eval, fixture | 20/20 cells, 456/456 checks (above) |

Exact test counts change as slices land; re-run `pnpm test` for the current total.

### Fixed since the baseline

The pre–Slice 1 flaws (the "Nothing needs your attention" title on `hub-fault`, "records" tiles, a spurious contradiction line) are fixed; the briefing eval checks each of them on every run.

## Live model (`MODEL_PROVIDER=explabs`)

**Not run on the parcel scenario.** Historical live samples are archived and must not be treated as parcel live-strict evidence.

| Mode | Status |
| --- | --- |
| live-strict (`pnpm eval:briefing`, report-only) | Not run for parcel: no model key available |
| live-fallback | Not run for parcel |

## Remaining

- **Live-strict briefing on hub-fault and quiet-day.** Largest open evidence gap after the fixture path is green.
- **Four-participant usability review.**
- Real identity provider and a real customer system before any deployed multi-user access.
- Optional: set `MODEL_USD_PER_MILLION` to record cost rather than `unknown`.

Pre-parcel evaluation numbers and matrix claims are preserved in [archive/pre-parcel-evaluation-results-2026-10-08.md](archive/pre-parcel-evaluation-results-2026-10-08.md).
