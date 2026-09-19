# DemoCo architecture

## Purpose

DemoCo is a local, read-only investigation workspace for a fictional B2B SaaS company. It turns a question into bounded specialist investigations, keeps the resulting evidence in runtime state, and presents only verified information in a generated workspace.

## Runtime path

```text
Browser shell
  ↕ AG-UI / CopilotKit transport
Agent runtime
  ├─ validates semantic user events
  ├─ plans and schedules domain tasks
  ├─ persists activity, evidence, findings, and surfaces
  └─ gives verified presentation data to the UI composer
       ↕ MCP client
Company MCP server → read-only company SQLite database
       ↓
UI composer → A2UI surface → Browser workspace
```

The web app contains only the shell, activity feed, input, and workspace renderer. It does not query company data. The agent runtime does not import the database. Specialist agents use only their tool allowlists through the MCP client. The UI composer has no MCP or database access.

## State and persistence

Company data is seeded deterministically and opened read-only. Runtime state is saved independently: graph checkpoints retain thread-level progress, while evidence, task traces, activity entries, and accepted UI surfaces are append-only records. An evidence record is committed before a finding that cites it; a surface is saved only after its referenced findings exist.

Graph state stores IDs and compact summaries. Full evidence payloads remain in runtime storage and are provided to a specialist only when relevant to its bounded task. Concurrent results are merged by stable ID; specialists cannot overwrite other specialists' findings.

## Trust boundaries

Every MCP tool validates inputs and returns a typed evidence envelope. The runtime validates all agent results: evidence IDs must exist, entities must be known, and numeric claims must resolve to evidence values or allowed deterministic derivations. Observations, hypotheses, and unresolved questions remain distinct in the presentation model.

Generated A2UI actions carry a known intent, entity references, and the surface revision. The runtime validates each action, deduplicates action IDs, and rejects stale references before beginning another task. No V1 action modifies company data.

## Main investigation

The broad morning question schedules Reliability, Product, and Customer tasks in parallel. Their evidence can establish timing, anomalous usage, and affected accounts. Once the affected customer set is known, Finance calculates represented ARR. The orchestrator merges verified findings, asks the UI composer for a new surface, and streams high-level events such as agent started, tool queried, finding discovered, and completed. It never sends model reasoning to the browser.

## Failure behavior

Each task can complete, return partial results, or fail. A Finance failure leaves operational and customer findings visible with a clear unavailable state. A malformed agent result can receive one repair attempt; a malformed UI surface leaves the previous accepted surface rendered. Cancelling a run prevents later work from becoming the active surface.
