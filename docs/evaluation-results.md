# Evaluation results

Updated 2026-10-08 for the Indian parcel network scenario (`logistics` @ `a51bda5` and follow-on agent-first briefing work). Human usability review is still open. **No live-model run has been performed on the parcel scenario**; numbers below are the deterministic fixture path unless noted.

## Suites on this branch

| Suite | What it measures | Command |
| --- | --- | --- |
| Unit / integration | contracts, runtime-storage, policy, logistics-db, logistics-mcp, agent | `pnpm test` |
| Playwright smoke | Fixture-backed shell: identity label, cancel, briefing progress / refresh; baseline screenshot | `pnpm test:e2e` |
| CLI inspect | Temporary runtime DB; prints surface stats JSON for a question | `pnpm --filter @anc/agent exec tsx src/cli.ts inspect "…"` |

The older investigation rubric and 66-cell acceptance matrix scripts are **not present on this branch**. A parcel morning-briefing eval (`eval:briefing`) is planned in Slice 6 of `.opencode/plans/anc-logistics-agent-first-briefing.md`.

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
| Playwright fixture smoke | gated in Slice 0 (see plan) |

Exact test counts change as slices land; re-run `pnpm test` for the current total.

### Known fixture briefing flaws (pre–Slice 1)

On `hub-fault` in fixture mode the surface title is still **"Nothing needs your attention this morning"** because every fixture finding is `medium` and `toPresentation` treats "no high/critical" as quiet. Metric tiles are labelled "records". Activity may include a spurious "Contradictory records values remain visible until resolved" line. Slice 1 of the agent-first briefing plan fixes ranking, reconciliation, and fixture specialist realism.

## Live model (`MODEL_PROVIDER=explabs`)

**Not run on the parcel scenario.** Historical live samples are archived and must not be treated as parcel live-strict evidence.

| Mode | Status |
| --- | --- |
| live-strict | Not run for parcel |
| live-fallback | Not run for parcel |

## Remaining

- **Live-strict briefing on hub-fault and quiet-day.** Largest open evidence gap after the fixture path is green.
- **Four-participant usability review.**
- **Briefing eval harness (Slice 6)** with persona sweep and action round-trip assertions.
- Real identity provider and a real customer system before any deployed multi-user access.
- Optional: set `MODEL_USD_PER_MILLION` to record cost rather than `unknown`.

Pre-parcel evaluation numbers and matrix claims are preserved in [archive/pre-parcel-evaluation-results-2026-10-08.md](archive/pre-parcel-evaluation-results-2026-10-08.md).
