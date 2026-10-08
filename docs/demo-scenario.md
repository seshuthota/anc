# Demo scenario

Fixed clock: Monday 21 September 2026, 07:00 IST (`2026-09-21T07:00:00.000+05:30`).

Seed: `pnpm logistics:seed` (defaults to `hub-fault`). Quiet control: `pnpm --filter @anc/logistics-db seed quiet-day` (or set the scenario argument / `LOGISTICS_DB_PATH` as needed).

Opening question (paraphrases are valid):

> What should I care about this morning?

## hub-fault story

Overnight, sorter belt B at the Hyderabad hub fails. By morning brief time the network shows:

| Figure | Meaning |
| --- | --- |
| **905** | Parcels promised for delivery today that are not yet on a truck (network-wide `totals.atRisk`) |
| **4,000** | Parcels promised for delivery today (`totals.promisedToday`) |
| **595** | Parcels waiting to sort at Hyderabad |
| **310** | Sorted at Hyderabad but not yet loaded |
| **609** | Parcels on held Hyderabad route runs |
| **296** | Parcels left behind on short-loaded runs (609 + 296 = 905 by construction; different definition) |
| **218** | Of the 905, parcels belonging to shipper-003 (Godavari Organics) — same metric, shipper scope |

Two Chennai lockers are filling up for an unrelated reason, so not everything on the day traces back to the sorter fault. Open late complaints need owners in the care queue.

Expected discovery path (specialists, not a scripted story):

1. Network sees the Hyderabad equipment fault and sort backlog.
2. Shipments sees 905 parcels at risk today and held / short-loaded runs.
3. Last-mile sees locker inbound pressure in Chennai.
4. Customers sees Godavari Organics' 218 at-risk parcels and any open complaints.

Root cause of "belt fault caused the 905" remains a hypothesis until the Lead Analyst connects observed links.

## quiet-day

Same network and clock with nothing wrong. The briefing should report that nothing needs attention (once Slice 1 ranking/reconciliation lands; today's fixture path still has known flaws — see the agent-first briefing plan).

## Personas

| Id | Person | Role |
| --- | --- | --- |
| `user-coo` | Ananya Reddy | Chief Operating Officer |
| `user-hub-hyd` | Ravi Teja Kondapalli | Hyderabad Hub Supervisor |
| `user-lastmile` | Meenakshi Subramanian | Last-Mile Lead |
| `user-accounts` | Arjun Mehta | Key Account Manager |
| `user-care` | Farah Siddiqui | Customer Care Lead |

## Same-shell tasks (no extra routes)

- Morning briefing: "What should I care about this morning?"
- Hub focus: "How is the Hyderabad hub doing?"
- At-risk parcels: "Which parcels are at risk of missing today's promise?"
- Lockers: "Which locker sites are under pressure?"
- Shipper commitment: "Is Godavari Organics on track for its on-time commitment?"
- Care: "Show unassigned complaints" then assign through the generated confirmation
- Unsupported: reroute / dispatch / redeliver / refund-style writes stop with a limitation
- Not granted: a persona asking outside their grants returns a limitation naming the unavailable domain

Replay without model calls: `pnpm replay`.

Evaluation: the older investigation rubric and live eval harness scripts are **not on this branch**. A parcel briefing eval is planned in Slice 6 of the agent-first briefing plan. Until then, use `pnpm test`, `pnpm test:e2e`, and `pnpm investigate`.

Pre-parcel wording for this document is preserved in [archive/pre-parcel-demo-scenario-2026-10-08.md](archive/pre-parcel-demo-scenario-2026-10-08.md).
