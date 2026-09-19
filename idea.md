Yep. I’d treat this as a completely greenfield spec and deliberately avoid giving the fictional company a cute startup name. We’ll just call it **`DemoCo`** in code so the branding doesn’t contaminate the experiment.

Below is the spec I’d hand to a coding agent.

# Agent-Native Generative Enterprise Workspace — MVP Specification

## 1. What we are building

Build a proof-of-concept enterprise application where the **application UI is not organized around predefined pages**.

Instead, the system consists of:

```text
Company data + tools + specialist agents + shared state
                         ↓
                    Orchestrator
                         ↓
                    Generative UI
                         ↓
                       Human
```

The human expresses an objective or asks a question.

The orchestrator decides which specialist agents are required. Those agents independently investigate using company tools exposed through MCP. Their findings are merged into shared state. A presentation layer then generates an appropriate interface for the current task.

The interface may therefore dynamically behave like:

```text
Executive dashboard
        ↓
Incident investigation
        ↓
Customer account view
        ↓
Revenue analysis
        ↓
Release investigation
```

without those being predefined application pages.

The purpose of the MVP is to test this hypothesis:

> Can an enterprise application emerge dynamically from company capabilities, specialist agents, shared state and generative UI instead of being implemented primarily as fixed screens and workflows?

---

# 2. Core principles

The MVP should preserve five architectural ideas.

**The UI is downstream of intent.** The frontend should not contain routes such as `/customers`, `/finance`, `/incidents`, `/analytics`, etc.

**Agents are specialized.** One giant LLM should not perform every task. The orchestrator should delegate work to agents responsible for distinct business functions.

**Agents interact with company systems through explicit capabilities.** Company data and operations should be exposed through MCP tools rather than dumped into prompts.

**Shared state belongs to the runtime, not to individual model contexts.** Agents contribute findings to a common investigation state.

**Generated UI uses an existing GenUI standard/library.** Do not create a custom JSON-to-React UI protocol.

---

# 3. Technology choices

For the MVP, use:

| Layer                     | Technology                     |
| ------------------------- | ------------------------------ |
| Frontend                  | Next.js + React + TypeScript   |
| Agent/UI integration      | CopilotKit                     |
| Agent ↔ Frontend protocol | AG-UI                          |
| Generative UI             | A2UI                           |
| Agent orchestration       | LangGraph TypeScript           |
| Tool/data protocol        | MCP                            |
| MCP implementation        | Official MCP TypeScript SDK v2 |
| Database                  | SQLite                         |
| Validation                | Zod                            |
| Package manager           | pnpm                           |
| Repository                | Monorepo                       |

AG-UI is specifically intended as the bidirectional protocol between agent backends and user-facing applications, including messages, state, lifecycle and tool events. CopilotKit already uses it as its agent/frontend transport. ([CopilotKit Docs][1])

A2UI should be used instead of inventing our own UI DSL. CopilotKit currently supports A2UI rendering through its runtime and React integration, with A2UI designed as a declarative, streaming-first GenUI specification. ([CopilotKit Docs][2])

For MCP, use the current TypeScript SDK v2 rather than old examples based on the original monolithic SDK. The v2 SDK is currently the stable release line and supports MCP tools, resources and prompts. ([MCP TypeScript SDK][3])

---

# 4. Fictional company

`DemoCo` is a fictional B2B SaaS company.

It sells a cloud collaboration/productivity product to other businesses.

The fictional organization has:

```text
Customers
Subscriptions
Product usage
Features
Support tickets
System telemetry
Application releases
Incidents
Invoices
Revenue
Account notes
```

The exact business is less important than having **multiple interconnected domains**.

The dataset should intentionally contain relationships that require several agents to discover.

---

# 5. The hidden demo scenario

Seed the synthetic dataset with one important event.

Yesterday evening, release:

```text
release-2026-09-19-3
```

introduced a regression in a synchronization component.

But don't make the cause trivially obvious.

The regression affects only customers with a particular configuration or feature enabled.

Its consequences spread across several company systems:

```text
Release
   ↓
Synchronization failures
   ↓
API error increase
   ↓
Feature usage decline
   ↓
Support tickets increase
   ↓
Enterprise customers affected
   ↓
Renewal/revenue exposure
```

No single specialist agent should initially have enough information to discover that entire chain.

The interesting behavior should emerge from collaboration.

---

# 6. Primary demo interaction

The best opening query should be:

> **What should I care about this morning?**

There should be no predefined implementation for that particular question.

The orchestrator should determine that it requires several investigations.

For example:

```text
                  Orchestrator
                       │
        ┌──────────────┼──────────────┐
        │              │              │
        ▼              ▼              ▼
 Reliability       Product         Customer
   Agent             Agent            Agent
        │              │              │
        └───────┬──────┴───────┬─────┘
                │              │
                ▼              ▼
             Finance       Shared state
              Agent
```

Potential findings:

```text
API error rate:
0.7% → 5.8%

Synchronization usage:
-19%

Support tickets mentioning sync:
+340%

Enterprise customers affected:
14

Revenue represented by affected accounts:
$2.1M ARR

Recent relevant deployment:
release-2026-09-19-3
```

The system then generates an appropriate A2UI workspace summarizing the situation.

---

# 7. Frontend

The permanent frontend should be intentionally tiny.

It contains only three structural areas:

```text
┌──────────────────────────────────────────────────────────┐
│ DemoCo                                           ● Ready │
├──────────────────────────────┬───────────────────────────┤
│                              │                           │
│                              │     Agent Activity        │
│    Generated Workspace       │                           │
│                              │                           │
│                              │                           │
├──────────────────────────────┴───────────────────────────┤
│ Ask anything about the company...                       │
└──────────────────────────────────────────────────────────┘
```

The application shell is fixed.

The business interface is not.

### Generated workspace

This area renders A2UI surfaces produced by the system.

It might contain:

```text
metrics
cards
tables
lists
forms
buttons
charts where supported
status indicators
detail views
timelines
```

Use the standard A2UI renderer supplied through the chosen framework wherever possible.

Do **not** create an internal abstraction like:

```typescript
interface GeneratedComponent {
    type: "chart" | "metric" | "table";
}
```

That would recreate a GenUI protocol that A2UI already provides.

Only introduce custom A2UI components later if the standard catalog proves insufficient.

---

# 8. Activity panel

The right-hand panel shows what the autonomous system is doing.

Example:

```text
Investigation

✓ Reliability Agent
  Checked service health

✓ Product Agent
  Detected unusual sync usage

● Customer Agent
  Checking affected accounts

● Finance Agent
  Estimating revenue exposure
```

This is **not chain-of-thought**.

Only expose high-level actions and results.

Valid activity events include:

```text
Agent started
Agent completed
Tool queried
Finding discovered
Task delegated
Investigation completed
Approval requested
```

AG-UI already exposes lifecycle, step, tool, message and state events that can support this type of frontend experience. ([CopilotKit Docs][4])

---

# 9. Agent architecture

Create five agents for V1.

## Orchestrator Agent

The orchestrator owns the investigation.

Responsibilities:

```text
Understand the user's objective
Determine required business domains
Create tasks
Delegate tasks
Run independent tasks in parallel
Collect findings
Resolve conflicting findings
Update shared state
Determine whether further investigation is necessary
Send final evidence to UI Composer
```

The orchestrator should **not** query databases directly.

It delegates research to domain agents.

---

## Reliability Agent

Responsible for:

```text
service health
latency
errors
incidents
deployments
system regressions
```

Available MCP tools:

```text
get_service_health
get_error_metrics
get_latency_metrics
get_recent_releases
get_incident_history
get_release_details
```

---

## Product Agent

Responsible for:

```text
feature usage
adoption
engagement
behavior changes
usage anomalies
```

Tools:

```text
get_product_usage
get_feature_usage
get_usage_trend
compare_usage_periods
get_customer_feature_usage
```

---

## Customer Agent

Responsible for:

```text
customers
accounts
support issues
account history
customer health
```

Tools:

```text
search_customers
get_customer
search_support_tickets
get_customer_support_history
get_customer_activity
```

---

## Finance Agent

Responsible for:

```text
subscriptions
ARR
billing
revenue
invoices
revenue exposure
```

Tools:

```text
get_subscription
get_customer_arr
get_revenue_summary
get_invoice_history
calculate_account_exposure
```

---

# 10. UI Composer

Treat UI generation as a separate responsibility.

The domain agents should **not** generate frontend layouts.

Their responsibility is producing trustworthy structured findings.

The UI Composer receives:

```text
User objective
Current investigation
Agent findings
Evidence
Important entities
Possible follow-up actions
```

and produces A2UI output.

Conceptually:

```text
Domain Agents
     │
     ▼
Structured findings
     │
     ▼
Orchestrator
     │
     ▼
UI Composer
     │
     ▼
A2UI
     │
     ▼
CopilotKit renderer
```

The UI Composer should have **no database access**.

It can only present data it has received.

That dramatically reduces opportunities for UI hallucination.

---

# 11. Agent result contract

Every specialist agent must return structured results.

Use a contract similar to:

```typescript
type AgentFinding = {
  id: string;
  title: string;
  description: string;

  severity?: "info" | "low" | "medium" | "high";

  evidenceRefs: string[];

  entities?: Array<{
    type: string;
    id: string;
    label: string;
  }>;

  metrics?: Array<{
    name: string;
    value: number;
    unit?: string;
    comparison?: number;
  }>;
};

type AgentResult = {
  agent: string;
  taskId: string;

  status: "completed" | "partial" | "failed";

  summary: string;

  findings: AgentFinding[];

  suggestedFollowUps: string[];
};
```

Agents may summarize evidence.

They may not fabricate evidence.

---

# 12. Evidence model

Every tool response should generate an evidence ID.

Example:

```json
{
  "evidenceId": "ev_0182",
  "source": "system_metrics",
  "tool": "get_error_metrics",
  "timestamp": "2026-09-20T08:04:11Z",
  "data": {
    "service": "sync-api",
    "currentErrorRate": 5.8,
    "previousErrorRate": 0.7
  }
}
```

Then an agent finding references:

```json
{
  "title": "Sync API errors increased sharply",
  "evidenceRefs": ["ev_0182"]
}
```

This gives us traceability:

```text
Generated UI
     ↓
Finding
     ↓
Agent
     ↓
Evidence
     ↓
MCP tool
     ↓
Company data
```

This should be one of the foundational properties of the system.

---

# 13. Shared runtime state

LangGraph should maintain shared investigation state.

Something conceptually similar to:

```typescript
interface CompanyWorkspaceState {

  conversation: Message[];

  objective: string;

  activeInvestigation?: {
    id: string;
    title: string;
    status: "running" | "completed";
  };

  tasks: InvestigationTask[];

  findings: AgentFinding[];

  evidence: Evidence[];

  selectedEntities: EntityRef[];

  activeSurface?: unknown;

  activity: ActivityEvent[];
}
```

The important point is that **agents do not own the company's current understanding**.

The runtime does.

An agent contributes:

```text
finding
evidence
entity
status
```

to shared state.

Future agents can consume those findings.

---

# 14. MCP architecture

Create one MCP server initially:

```text
company-mcp
```

Architecture:

```text
Agents
   │
   │ MCP
   ▼
Company MCP Server
   │
   ├── Reliability domain
   ├── Product domain
   ├── Customer domain
   └── Finance domain
           │
           ▼
        SQLite
```

Later these could become separate MCP servers.

For the MVP, one server is easier to debug.

---

# 15. Do not expose raw SQL initially

Avoid giving agents:

```text
execute_sql(query)
```

Instead expose meaningful company capabilities.

Bad:

```text
SELECT *
FROM customer_events...
```

Better:

```text
get_customer_activity(customerId)
```

or:

```text
get_feature_usage(
    feature,
    startDate,
    endDate,
    customerSegment
)
```

This gives MCP tools understandable semantics and makes permission boundaries clearer.

A generic read-only analytics query can be added later if necessary.

---

# 16. Synthetic database

Seed approximately:

```text
100 customers
100 subscriptions
30 days product metrics
30 days system metrics
10 releases
200 support tickets
500 invoices
several thousand usage records
5 historical incidents
```

Recommended tables:

```text
customers
subscriptions
product_usage_daily
feature_usage_daily
service_metrics
releases
incidents
support_tickets
invoices
account_notes
```

The seed script must be deterministic.

Every developer should receive the same hidden scenario.

Use something like:

```text
seed = 42
```

rather than generating a different company every startup.

---

# 17. Important seeded relationships

The database should support discovering this chain:

```text
release-2026-09-19-3
        │
        ▼
sync-worker regression
        │
        ▼
certain account configuration
        │
        ▼
higher sync errors
        │
        ▼
feature usage decrease
        │
        ▼
support complaints
        │
        ▼
enterprise customers impacted
        │
        ▼
revenue exposure
```

The database should **not contain that explanation directly**.

Agents should derive it from evidence.

For example:

Reliability discovers:

```text
errors started shortly after deployment
```

Product discovers:

```text
sync usage dropped
```

Customer discovers:

```text
sync-related complaints increased
```

Finance discovers:

```text
affected accounts represent $2.1M ARR
```

The orchestrator connects them.

That's the experiment.

---

# 18. First generated experience

When the user asks:

> What should I care about this morning?

the generated interface might become:

```text
──────────────────────────────────────────

Morning Overview

⚠ Potential synchronization incident

Error Rate
5.8%
↑ from 0.7%

Customers affected
14

Revenue represented
$2.1M ARR


ERROR TREND

     │                   ╭────────
     │                 ╭─╯
     │_________________╯
     └────────────────────────────


Evidence suggests the issue began shortly
after release release-2026-09-19-3.


[Investigate]
[Show affected customers]
[Inspect release]

──────────────────────────────────────────
```

These controls should send semantic events back to the agent.

For example:

```json
{
  "action": "investigate",
  "entity": {
    "type": "release",
    "id": "release-2026-09-19-3"
  }
}
```

Do not turn them into frontend navigation routes.

---

# 19. Follow-up interaction

The user clicks:

> **Investigate**

The orchestrator creates a deeper investigation.

The generated workspace may transform into:

```text
Sync Incident Investigation

Timeline
────────────────────────────────

18:02   Release deployed
18:21   Errors begin increasing
18:47   Usage starts declining
19:15   First support complaint
21:30   Enterprise impact detected


Likely correlation

release-2026-09-19-3
        ↓
sync-worker
        ↓
configuration X
        ↓
sync failures


Affected customers

14 enterprise customers
$2.1M ARR represented

[Customers]
[Release details]
[Financial impact]
```

Notice that the application has now effectively transformed from an executive dashboard into an incident investigation system.

No predefined `IncidentPage` should exist.

---

# 20. Another drill-down

User:

> Show affected customers.

Customer Agent runs.

The same workspace becomes:

```text
Affected Accounts

Customer          ARR       Errors     Tickets
──────────────────────────────────────────────
Customer 024      $410K      1,821        7
Customer 018      $290K      1,104        3
Customer 071      $240K        911        4
...
```

Selecting a customer might then generate:

```text
Customer 024

ARR
$410K

Subscription
Enterprise

Account Health
At Risk

Current incident
Sync failures

Recent Support
7 tickets

Product usage
-31%

[Support history]
[Usage]
[Financial exposure]
```

Again:

**same application shell, completely different functional interface.**

---

# 21. Parallelism

Independent agent tasks should execute concurrently.

For the morning query:

```text
                    Orchestrator
                         │
          ┌──────────────┼───────────────┐
          │              │               │
          ▼              ▼               ▼
    Reliability       Product         Customer
          │              │               │
          └──────────────┼───────────────┘
                         │
                         ▼
                      Finance
```

Finance might execute after affected customer IDs are known.

The activity feed should update while this occurs.

The user should see the application progressively form rather than wait for every agent to finish before anything appears.

---

# 22. Streaming

Use AG-UI streaming throughout.

The UI should be able to show:

```text
Orchestrator started
↓
Reliability Agent started
Product Agent started
Customer Agent started
↓
Reliability finding received
↓
partial UI update
↓
Customer finding received
↓
UI updated
↓
Finance investigation started
↓
final UI
```

AG-UI's event-oriented model is well suited to this because it supports run events, step events, text, tool calls and state updates over the frontend-agent connection. ([CopilotKit Docs][4])

---

# 23. Human interaction with generated UI

Generated UI interactions should become agent events rather than direct business operations.

Example:

```text
[Investigate]
```

means:

```text
user wants deeper investigation
```

not:

```text
GET /incident-page
```

Likewise:

```text
[Show customers]
```

becomes context:

```text
User selected affected customers
within investigation inc_123.
```

The agent decides how to respond.

This distinction is fundamental to the experiment.

---

# 24. Read-only MVP

V1 should be **completely read-only**.

Agents may:

```text
query
analyze
compare
investigate
explain
generate interfaces
```

Agents may not:

```text
change subscriptions
modify customers
deploy releases
issue refunds
edit invoices
delete data
restart services
```

This prevents action authorization from distracting from the primary experiment.

---

# 25. V2 action model

Design the architecture so actions can later become:

```text
Agent proposes action
        ↓
Policy validates
        ↓
Generated confirmation UI
        ↓
Human approves
        ↓
MCP tool executes
        ↓
Audit record created
```

Example:

```text
Rollback release?

Affected customers: 14
Current error rate: 5.8%
Estimated recovery: 12 minutes

[Approve rollback]
[Cancel]
```

But do not implement this yet.

---

# 26. Repository structure

Recommended monorepo:

```text
agent-company-demo/

  apps/

    web/
      app/
      components/
      copilot/
      workspace/
      activity/

    agent/
      orchestrator/
      agents/
        reliability/
        product/
        customer/
        finance/
        ui-composer/
      graph/
      state/
      prompts/

    company-mcp/
      tools/
        reliability/
        product/
        customer/
        finance/
      server/
      db/

  packages/

    contracts/
      findings.ts
      evidence.ts
      entities.ts
      activity.ts

    database/
      schema/
      seed/

    config/

  docs/
      architecture.md
      demo-scenario.md

  pnpm-workspace.yaml
```

---

# 27. Important design rule: dependency direction

Maintain this dependency structure:

```text
Frontend
   ↓
AG-UI
   ↓
Orchestrator
   ↓
Domain Agents
   ↓
MCP Client
   ↓
Company MCP Server
   ↓
Database
```

And separately:

```text
Investigation State
        ↓
UI Composer
        ↓
A2UI
        ↓
Frontend
```

Do not allow:

```text
Frontend → Database
Frontend → Company APIs
UI Composer → Database
```

---

# 28. Agent prompts

The specialist-agent base prompt should emphasize:

```text
You are a specialist inside DemoCo.

Your responsibility is to investigate tasks assigned
by the orchestrator within your business domain.

Use company tools to obtain facts.

Never invent company data.

Every factual finding must reference evidence returned
by a company tool.

Do not attempt to design UI.

Do not answer questions outside your assigned domain.

If another domain is required, report that requirement
to the orchestrator.

Return structured AgentResult output.
```

The orchestrator prompt should emphasize:

```text
You coordinate specialist agents.

Your job is not to perform specialist analysis yourself.

Break user objectives into investigation tasks.

Delegate those tasks to the appropriate agents.

Execute independent tasks concurrently.

Use existing shared-state findings before requesting
duplicate work.

When evidence conflicts, investigate further rather than
silently selecting one result.

Stop investigating when enough evidence exists to answer
the user's objective.

Send verified findings and evidence to the UI Composer.
```

---

# 29. UI Composer rules

Its instructions should include:

```text
Build an interface for the user's current objective.

Use only information contained in the supplied findings
and evidence.

Do not invent metrics, entities or explanations.

Prefer visualization over long prose when structured data
is available.

Emphasize important anomalies.

Provide useful drill-down actions where appropriate.

Do not assume predefined application pages.

The interface should represent what is useful NOW,
not a permanent navigation hierarchy.
```

Output must follow A2UI.

---

# 30. Observability

Every investigation should receive:

```text
investigationId
runId
taskId
agentId
toolCallId
evidenceId
```

Log:

```text
user request
orchestration plan
agent start/end
tool invocation
tool result
finding
state update
UI generation
duration
token usage
errors
```

Do not log private model reasoning.

This gives us enough information to inspect why the system behaved the way it did.

---

# 31. Error handling

Agent failures must not collapse the entire experience.

Example:

```text
Finance Agent unavailable
```

The UI should still present:

```text
Operational impact confirmed
14 customers affected

Financial impact
Unable to calculate currently
```

with a possible retry action.

Partial information should be treated explicitly as partial.

---

# 32. MVP success criteria

The implementation is successful when all of these work:

1. The application launches with almost no predefined business UI.

2. The user can ask:

   **“What should I care about this morning?”**

3. The orchestrator delegates the question to multiple specialist agents.

4. Specialist agents use MCP tools rather than receiving the entire database in context.

5. At least two agents execute concurrently.

6. Findings are written into shared runtime state.

7. Every major numeric/business claim can be traced to evidence.

8. The interface is produced using A2UI rather than a custom GenUI schema.

9. The user sees high-level live agent activity.

10. The generated workspace exposes meaningful drill-down interactions.

11. Clicking a generated action sends context back to the agent instead of navigating to a predefined page.

12. Follow-up questions reuse current investigation state.

13. The same workspace can evolve from overview → incident → customers → customer detail without using separately coded business pages.

14. Refreshing/replaying an investigation produces understandable state rather than depending entirely on hidden LLM context.

---

# 33. Things explicitly NOT to build

This is important, because an autonomous coding agent will happily build us a small SAP clone if we let it loose. 😂

For the first implementation, do **not** build:

```text
authentication
roles
production authorization
writes/actions
Kafka
Redis
vector database
Kubernetes
microservices
customer login
real billing integration
real observability systems
custom component framework
custom GenUI protocol
mobile app
long-term agent memory
agent-created agents
dozens of specialist agents
arbitrary SQL generation
production-grade scaling
```

Keep the experiment focused.

---

# 34. Implementation sequence

I would instruct the coding agent to build it in this order:

```text
STEP 1
Monorepo + SQLite + deterministic seed data

STEP 2
Company MCP server

STEP 3
Test MCP tools independently

STEP 4
Implement specialist agents

STEP 5
Define shared LangGraph state

STEP 6
Implement orchestrator graph

STEP 7
Verify multi-agent investigation entirely from CLI/tests

STEP 8
Add CopilotKit + AG-UI frontend connection

STEP 9
Add A2UI generated workspace

STEP 10
Add agent activity stream

STEP 11
Implement generated UI interactions

STEP 12
Implement the complete demo storyline

STEP 13
Add tracing/evidence inspection

STEP 14
Polish UI
```

The ordering matters.

**Do not start with the pretty frontend.**

First make:

```text
Question
   ↓
agents
   ↓
MCP
   ↓
evidence
   ↓
shared findings
```

work correctly.

Then attach generative UI.

---

# 35. The key test

At the end, sit someone in front of it who doesn't know the architecture.

Start with essentially this:

```text
┌─────────────────────────────────────────────┐
│ DemoCo                                      │
│                                             │
│                                             │
│        What would you like to know?         │
│                                             │
│                                             │
│                                             │
│                                             │
│ Ask anything...                             │
└─────────────────────────────────────────────┘
```

Ask:

> **What should I care about this morning?**

And watch the application **become something**.

Then ask:

> Why is this happening?

It should become something else.

Then:

> Who is affected?

Something else.

Then select a customer.

Something else again.

If we get to the end of that sequence and it feels like we navigated through four different enterprise applications **without any of those applications actually existing as fixed products**, then the MVP has proven the interesting part of the idea.

---

## Copy this section directly to your coding agent

> Implement the **Agent-Native Generative Enterprise Workspace MVP** described in this specification.
>
> Treat `DemoCo` as a fictional B2B SaaS company. Use synthetic deterministic data only.
>
> Use a TypeScript monorepo with Next.js/React, CopilotKit, AG-UI, A2UI, LangGraph TypeScript, the official MCP TypeScript SDK v2, SQLite and Zod.
>
> The frontend must contain only a minimal application shell, conversation input, generated workspace and agent-activity panel. Do not implement predefined business pages or navigation such as customers, analytics, finance, incidents or releases.
>
> Build five runtime responsibilities: Orchestrator, Reliability Agent, Product Agent, Customer Agent, Finance Agent and a UI Composer. Specialist agents obtain company information exclusively through MCP tools and return structured findings referencing evidence IDs.
>
> Maintain investigation state centrally in LangGraph. Agents must contribute findings and evidence to shared state rather than relying solely on conversational context.
>
> Use A2UI for generated interfaces. Do not invent a custom JSON UI schema or custom generative-UI protocol. Use existing A2UI/CopilotKit rendering capabilities first; extend them only if absolutely necessary.
>
> Implement the seeded hidden scenario where a recent software release causes synchronization failures affecting a subset of enterprise customers, leading to abnormal system metrics, declining feature usage, increased support tickets and revenue exposure. No database record should directly explain the entire causal chain; the agents must discover it through separate company systems.
>
> The primary demonstration begins with the user asking: **“What should I care about this morning?”** The orchestrator should launch relevant specialist investigations, preferably in parallel, combine their evidence and generate an appropriate workspace. The user must then be able to investigate the anomaly, inspect affected customers and drill into a customer without navigating predefined pages.
>
> Stream high-level agent activities to the frontend using AG-UI events. Never expose model chain-of-thought. Expose only actions such as agent started, company tool queried, finding discovered, task completed and investigation completed.
>
> V1 is read-only. Do not implement company-changing actions, authorization systems, production infrastructure, long-term memory, Kafka, Redis, vector databases or arbitrary SQL.
>
> Build functionality in vertical stages and keep the application runnable after every stage. Add tests for MCP tools, structured agent results, evidence traceability, orchestration and the main demo flow.
>
> Before writing substantial code, create `docs/architecture.md` and `docs/implementation-plan.md` based on this specification. Then implement sequentially and update the implementation plan as milestones are completed.

One thing I particularly want to preserve here is that **A2UI, AG-UI and MCP have three cleanly different jobs**:

```text
A2UI  → Agent describes what the human should SEE

AG-UI → Human/interface ↔ agent runtime communication

MCP   → Agent ↔ company capabilities/data
```

That separation gives this experiment a surprisingly clean architecture instead of turning into “LLM calls some APIs and outputs React.” And all three layers now have current ecosystem support rather than requiring us to invent them ourselves. ([CopilotKit][5])

[1]: https://docs.copilotkit.ai/ag2/agentic-protocols/ag-ui "https://docs.copilotkit.ai/ag2/agentic-protocols/ag-ui"
[2]: https://docs.copilotkit.ai/generative-ui/a2ui "https://docs.copilotkit.ai/generative-ui/a2ui"
[3]: https://ts.sdk.modelcontextprotocol.io/v2/ "https://ts.sdk.modelcontextprotocol.io/v2/"
[4]: https://docs.copilotkit.ai/angular/langgraph-typescript/backend/ag-ui "https://docs.copilotkit.ai/angular/langgraph-typescript/backend/ag-ui"
[5]: https://www.copilotkit.ai/ag-ui "https://www.copilotkit.ai/ag-ui"

