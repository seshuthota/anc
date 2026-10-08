/**
 * pnpm eval:briefing: checks the morning briefing invariants (R1–R6) across both
 * seeded scenarios and every persona.
 *
 * Modes (MODEL_EXECUTION_MODE):
 * - fixture (default, CI): deterministic. Each cell runs twice: "deterministic"
 *   (runtime fallbacks, no model) and "replay" (hand-written model replies from
 *   __fixtures__/model-replies/, which also exercise review → repair). Must be 100%.
 * - live-strict (MODEL_PROVIDER=explabs, EVAL_REPEATS=n): the configured model,
 *   no substitutions counted as passes. Report only: exits 0 unless the harness itself breaks.
 *
 * Writes a JSON report to test-results/eval-briefing.json (EVAL_REPORT to override).
 */
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.env.MODEL_EXECUTION_MODE ?? "fixture";
if (mode !== "fixture" && mode !== "live-strict") {
  console.error(`eval:briefing supports MODEL_EXECUTION_MODE=fixture (default) or live-strict, not ${mode}`);
  process.exit(2);
}
if (mode === "fixture") {
  process.env.MODEL_PROVIDER = "fixture";
  process.env.MODEL_EXECUTION_MODE = "fixture";
}
process.env.INVESTIGATION_STEP_DELAY_MS = "0";
const repeats = Math.max(1, Number(process.env.EVAL_REPEATS ?? 1));
const workspace = mkdtempSync(join(tmpdir(), "anc-eval-briefing-"));
process.env.RUNTIME_DB_PATH = join(workspace, "runtime.sqlite");

const { openLogisticsDatabase, seedLogistics, logisticsSchemaOutdated } = await import("@anc/logistics-db");
const { migrateCompanyDatabase } = await import("../mcp-client.js");
/**
 * Every company database the eval reads is seeded fresh at schema v2, and is
 * also run through the runtime's startup migration (a no-op on a v2 seed), then
 * checked read-only, so a specialist's read-only MCP server can never hit the
 * "predates schema v2" refusal mid-run.
 */
function assertSchemaV2(path: string) {
  migrateCompanyDatabase(path);
  const probe = openLogisticsDatabase(path, true);
  try {
    if (logisticsSchemaOutdated(probe)) throw new Error(`eval:briefing: ${path} predates schema v2 after seeding and migration`);
  } finally {
    probe.close();
  }
}
const scenarios = ["hub-fault", "quiet-day"] as const;
type Scenario = (typeof scenarios)[number];
const seeded: Record<Scenario, string> = { "hub-fault": "", "quiet-day": "" };
for (const scenario of scenarios) {
  const path = join(workspace, `${scenario}.sqlite`);
  const db = openLogisticsDatabase(path);
  seedLogistics(db, scenario);
  db.close();
  assertSchemaV2(path);
  seeded[scenario] = path;
}
process.env.LOGISTICS_DB_PATH = seeded["hub-fault"];

const { runInvestigation, handleAction, publicState, store } = await import("../runtime.js");
const { reconcileMetrics, headlineMetrics, scopeKey } = await import("../reconcile.js");
const { figureGate } = await import("../synthesis.js");
const { useSynthesisModel } = await import("../synthesis.js");
const { useComposerModel } = await import("../ui-composer.js");
const { synthesisReplay, composerReplay } = await import("./replay.js");
const { resolvePrincipal } = await import("@anc/policy");
const { peekSubstitutions } = await import("../execution.js");
import type { AgentFinding } from "@anc/contracts";

const BRIEF = "Brief me: what needs my attention this morning?";
const PERSONAS = ["user-coo", "user-hub-hyd", "user-lastmile", "user-accounts", "user-care"] as const;
const EXPECT_PRIMARY: Record<Scenario, number> = { "hub-fault": 1, "quiet-day": 0 };

type Check = { name: string; ok: boolean; detail?: string };
type Cell = { scenario: Scenario; persona: string; variant: string; repeat: number; title: string; checks: Check[] };
type Component = { id?: string; component?: string; child?: string; children?: string[]; action?: { event?: { name?: string; context?: Record<string, unknown> } } } & Record<string, unknown>;
type Briefing = {
  primary?: { findingId: string; headline: string; whyItMatters: string; evidenceIds: string[]; metric?: { metricId: string; value: string; evidenceIds: string[] }; chain: Array<{ evidenceIds: string[] }> };
  secondary: Record<string, { id: string; title: string; evidenceIds: string[]; metricId?: string; resultPath?: string }>;
  actions: Array<{ id: string; name: string }>;
};

const normalize = (figure: string) => figure.replace(/,/g, "").replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
const figuresIn = (text: string) => (text.match(/\d[\d,.:]*\d|\d/g) ?? []).filter((figure) => !figure.includes(":"));

function componentsOf(state: ReturnType<typeof publicState>): Component[] {
  const update = (state.surface?.messages as Array<Record<string, unknown>> | undefined)?.find((message) => "updateComponents" in message) as { updateComponents: { components: Component[] } } | undefined;
  return update?.updateComponents.components ?? [];
}

function readPointer(data: unknown, pointer: string): unknown {
  return pointer.split("/").filter(Boolean).reduce<unknown>((cursor, part) => (cursor && typeof cursor === "object" ? (cursor as Record<string, unknown>)[part] : undefined), data);
}

function boundPaths(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) value.forEach((item) => boundPaths(item, found));
  else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.path === "string" && Object.keys(record).length === 1) found.push(record.path);
    else Object.values(record).forEach((item) => boundPaths(item, found));
  }
  return found;
}

/** The R1–R4 invariants on one briefing surface. */
function checkSurface(scenario: Scenario, state: ReturnType<typeof publicState>, findings: AgentFinding[]): Check[] {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(ok || !detail ? {} : { detail }) });
  const components = componentsOf(state);
  const byId = new Map(components.map((component) => [String(component.id), component]));
  const reachable = new Set<string>();
  const walk = (id: string) => {
    const component = byId.get(id);
    if (!component || reachable.has(id)) return;
    reachable.add(id);
    for (const kid of [...(component.children ?? []), ...(typeof component.child === "string" ? [component.child] : [])]) walk(String(kid));
  };
  walk("root");
  const shown = components.filter((component) => reachable.has(String(component.id)));
  const ofType = (type: string) => shown.filter((component) => component.component === type);
  const inside = new Set<string>();
  const walkInside = (id: string) => {
    const component = byId.get(id);
    if (!component || inside.has(id)) return;
    inside.add(id);
    for (const kid of [...(component.children ?? []), ...(typeof component.child === "string" ? [component.child] : [])]) walkInside(String(kid));
  };
  for (const collapsible of ofType("Collapsible")) walkInside(String(collapsible.id));
  const data = (state.surface?.dataModel ?? {}) as { title?: string; briefing?: Briefing };
  const briefing = data.briefing;

  // R1: exactly one primary on the fault day, none on a quiet day.
  check("R1 briefing plan present", Boolean(briefing), "no briefing in the data model");
  const primaries = ofType("PrimaryFinding").length;
  check(`R1 ${EXPECT_PRIMARY[scenario]} PrimaryFinding`, primaries === EXPECT_PRIMARY[scenario], `found ${primaries}`);
  check("R1 primary in the plan matches the surface", Boolean(briefing?.primary) === (primaries === 1));
  if (scenario === "hub-fault") check("R1 title is not the calm line on the fault day", !/^Nothing needs your attention/.test(data.title ?? ""), data.title);

  // R3: the budget.
  const secondary = Object.values(briefing?.secondary ?? {});
  check("R3 at most 3 secondary items", secondary.length <= 3, `found ${secondary.length}`);
  const actionButtons = shown.filter((component) => component.component === "Button" && !inside.has(String(component.id)) && component.action?.event?.name !== "show_evidence");
  check("R3 at most 3 action buttons", actionButtons.length <= 3, `found ${actionButtons.length}`);
  check("R3 at most 3 planned actions", (briefing?.actions.length ?? 0) <= 3, `found ${briefing?.actions.length}`);
  check("R3 at most 1 Collapsible", ofType("Collapsible").length <= 1, `found ${ofType("Collapsible").length}`);
  check("R3 0 free Stat tiles", ofType("Stat").length === 0, `found ${ofType("Stat").length}`);
  check("R3 0 free Cards", ofType("Card").length === 0, `found ${ofType("Card").length}`);
  check("R3 0 Sequence outside the primary", ofType("Sequence").length === 0, `found ${ofType("Sequence").length}`);
  if (!briefing?.primary) check("R6 no actions without a primary", actionButtons.filter((button) => button.action?.event?.name === "propose_action").length === 0);

  // R4: every figure on screen carries its evidence.
  const unbound: string[] = [];
  for (const path of boundPaths(shown)) {
    const value = readPointer(data, path);
    const leaf = path.split("/").filter(Boolean).at(-1) ?? "";
    const figure = typeof value === "number" || (leaf === "value" && typeof value === "string" && /\d/.test(value));
    if (!figure) continue;
    const parent = readPointer(data, path.split("/").slice(0, -1).join("/")) as { evidenceIds?: unknown } | undefined;
    if (!Array.isArray(parent?.evidenceIds) || !parent.evidenceIds.length) unbound.push(path);
  }
  check("R4 every bound figure has evidenceIds beside it", !unbound.length, unbound.join(", "));
  if (briefing?.primary) {
    check("R4 primary figure has evidenceIds", Boolean(briefing.primary.metric?.evidenceIds.length), "primary metric without evidence");
    check("R4 every chain hop has evidenceIds", briefing.primary.chain.every((hop) => hop.evidenceIds.length > 0));
  }
  check("R4 every secondary item has evidenceIds", secondary.every((item) => item.evidenceIds.length > 0));

  // R2: shown figures are reconciled ones.
  const reconciled = reconcileMetrics(findings);
  const gate = figureGate(reconciled);
  if (briefing?.primary) {
    const stray = [...figuresIn(briefing.primary.headline), ...figuresIn(briefing.primary.whyItMatters)].filter((figure) => !gate.allowed.has(normalize(figure)));
    check("R2 headline figures ⊂ reconciled metrics", !stray.length, `not reconciled: ${stray.join(", ")}`);
    const metric = briefing.primary.metric;
    const headline = metric ? headlineMetrics(reconciled).find((item) => item.metricId === metric.metricId && item.findingIds.includes(briefing.primary!.findingId)) : undefined;
    check("R2 primary figure is a headline-eligible reconciled metric", !metric || (Boolean(headline) && normalize(metric.value) === normalize(String(headline!.value))), metric ? `${metric.metricId}=${metric.value}` : undefined);
  }
  // Each shown figure maps to one reconciled (metricId, scope, window) group.
  type Shown = { key: string; value: number; scope: { type: string; id?: string }; metricId: string; ofWhichOf?: string; title?: string };
  const shownMetrics: Shown[] = [];
  const conflicted = new Set(reconciled.conflicts.map((conflict) => conflict.metricId + "|" + conflict.scopeKey));
  const missing: string[] = [];
  const add = (findingId: string, metricId: string | undefined, title?: string) => {
    if (!metricId) return;
    const metric = reconciled.metrics.find((item) => item.metricId === metricId && item.findingIds.includes(findingId));
    if (!metric) { missing.push(`${metricId} (${findingId})`); return; }
    shownMetrics.push({ key: `${metric.metricId}|${scopeKey(metric.scope)}|${metric.window}`, value: metric.value, scope: metric.scope, metricId: metric.metricId, ofWhichOf: metric.ofWhichOf, title });
  };
  if (briefing?.primary) add(briefing.primary.findingId, briefing.primary.metric?.metricId);
  for (const item of secondary) add(item.id, item.metricId, item.title);
  check("R2 every shown figure is reconciled (none conflicted or dropped)", !missing.length && shownMetrics.every((item) => !conflicted.has(`${item.metricId}|${scopeKey(item.scope as never)}`)), missing.join(", "));
  const byKey = new Map<string, Set<number>>();
  for (const item of shownMetrics) byKey.set(item.key, (byKey.get(item.key) ?? new Set()).add(item.value));
  const clashes = [...byKey].filter(([, values]) => values.size > 1).map(([key]) => key);
  check("R2 no two shown metrics share (metricId, scope, window) with different values", !clashes.length, clashes.join(", "));
  // A child scope next to its parent is only allowed as an explicit of-which ("218 of the 905").
  const siblings = shownMetrics.filter((child) => shownMetrics.some((parent) => parent !== child && parent.metricId === child.metricId && parent.key !== child.key && child.ofWhichOf === parent.key)
    && !(child.title && new RegExp(`\\bof the ${shownMetrics.find((parent) => parent.key === child.ofWhichOf)!.value.toLocaleString("en-IN")}\\b`).test(child.title)));
  check("R2 no parent/child scope siblings (children only as an explicit of-which)", !siblings.length, siblings.map((item) => `${item.key} "${item.title}"`).join("; "));
  return checks;
}

const cells: Cell[] = [];
const log = { synthesisCalls: 0, composerCalls: 0 };
const variants = mode === "fixture" ? ["deterministic", "replay"] : ["live"];
let thread = 0;

for (const scenario of scenarios) {
  process.env.LOGISTICS_DB_PATH = seeded[scenario];
  for (const variant of variants) {
    for (let repeat = 1; repeat <= repeats; repeat += 1) {
      for (const personaId of PERSONAS) {
        const principal = resolvePrincipal(personaId);
        const before = { ...log };
        if (variant === "replay") {
          useSynthesisModel(synthesisReplay(log));
          useComposerModel(composerReplay(log));
        } else {
          useSynthesisModel(undefined);
          useComposerModel(undefined);
        }
        const threadId = `eval-${scenario}-${variant}-${personaId}-${repeat}-${(thread += 1)}`;
        let checks: Check[];
        let title = "";
        try {
          const state = await runInvestigation({ question: BRIEF, threadId, principal });
          title = state.surface?.title ?? "";
          const findings = store.listFindings(state.runId!) as AgentFinding[];
          checks = [{ name: "run completed", ok: state.status === "completed", ...(state.status === "completed" ? {} : { detail: state.status }) }, ...checkSurface(scenario, state, findings)];
          const substituted = peekSubstitutions(state.runId!).map((item) => item.specialist);
          const briefing = (state.surface?.dataModel as { briefing?: Briefing }).briefing;
          if (variant === "replay") {
            const composed = componentsOf(state).some((component) => String(component.id).startsWith("rp_"));
            checks.push({ name: "replay: composer reply 1 (over budget) rejected, reply 2 shown", ok: log.composerCalls - before.composerCalls === 2 && composed, detail: `calls ${log.composerCalls - before.composerCalls}, model tree shown: ${composed}` });
            if (briefing?.primary && findings.length >= 2) {
              checks.push({ name: "replay: analyst reply 1 (invented figure) rejected, reply 2 accepted", ok: log.synthesisCalls - before.synthesisCalls === 2 && !substituted.includes("lead-analyst"), detail: `calls ${log.synthesisCalls - before.synthesisCalls}, substituted: ${substituted.join(",") || "none"}` });
            }
          }
          if (variant === "live") checks.push({ name: "live: no substitution", ok: substituted.length === 0, detail: substituted.join(",") });
        } catch (error) {
          checks = [{ name: "run completed", ok: false, detail: error instanceof Error ? error.message : String(error) }];
        }
        cells.push({ scenario, persona: personaId, variant, repeat, title, checks });
      }
    }
  }
}
useSynthesisModel(undefined);
useComposerModel(undefined);

// R6: the action round-trip, on a fresh copy of the fault day. Each offered
// operation: propose → confirm → the row changed → a receipt on the same card.
// A persona without the grant is refused; the next briefing offers none of them again.
const roundTrip: Check[] = [];
{
  const copy = join(workspace, "hub-fault-roundtrip.sqlite");
  copyFileSync(seeded["hub-fault"], copy);
  assertSchemaV2(copy);
  process.env.LOGISTICS_DB_PATH = copy;
  const coo = resolvePrincipal("user-coo");
  const threadId = "eval-roundtrip-coo";
  const act = (principal: typeof coo, name: string, parameters: Record<string, unknown>, onThread = threadId) => {
    const current = publicState(onThread, principal.id);
    return handleAction({ name, threadId: onThread, surfaceId: current.surface?.surfaceId, surfaceRevision: current.surface?.revision, parameters }, principal);
  };
  const query = <T>(sql: string) => {
    const db = openLogisticsDatabase(copy, true);
    try { return db.prepare(sql).get() as T; } finally { db.close(); }
  };
  const effects: Record<string, () => boolean> = {
    escalate_equipment_fault: () => query<{ n: number }>("SELECT COUNT(*) n FROM equipment_events WHERE id = 'eq-hyd-0920' AND escalated_to = 'emp-eng-hyd' AND escalated_at IS NOT NULL").n === 1,
    notify_shipper: () => query<{ n: number }>("SELECT COUNT(*) n FROM shipper_notifications WHERE shipper_id = 'shipper-003' AND status = 'queued'").n === 1,
    assign_complaints: () => query<{ n: number }>(`SELECT COUNT(*) n FROM complaints c JOIN shipments s ON s.id = c.shipment_id
      WHERE c.status = 'open' AND c.category = 'late' AND c.assignee_id IS NULL AND substr(s.promised_by, 1, 10) = '2026-09-21' AND s.status IN ('at_hub', 'sorted')`).n === 0,
  };
  try {
    const brief = await runInvestigation({ question: BRIEF, threadId, principal: coo });
    const offered = ((brief.surface?.dataModel as { briefing?: Briefing }).briefing?.actions ?? []).filter((action) => action.name === "propose_action").map((action) => action.id);
    roundTrip.push({ name: "COO is offered all three operations", ok: offered.length === 3, detail: offered.join(", ") });
    await handleAction({ name: "propose_action", threadId: "eval-roundtrip-forged", parameters: { actionId: "escalate_equipment_fault" } }, resolvePrincipal("user-accounts"))
      .then(() => roundTrip.push({ name: "a persona without the grant is refused", ok: false, detail: "forged propose was accepted" }))
      .catch((error: Error) => roundTrip.push({ name: "a persona without the grant is refused", ok: /Not authorized/.test(error.message), detail: error.message }));
    for (const actionId of offered) {
      const before = effects[actionId]!();
      const proposed = await act(coo, "propose_action", { actionId });
      const pending = (proposed.surface?.dataModel as { briefing?: { pending?: { proposalId: string; blocked?: boolean } } }).briefing?.pending;
      if (!pending || pending.blocked) { roundTrip.push({ name: `${actionId}: proposed with a confirm`, ok: false, detail: JSON.stringify(pending) }); continue; }
      const done = await act(coo, "confirm_action", { proposalId: pending.proposalId });
      const receipts = (done.surface?.dataModel as { briefing?: { primary?: { receipts?: Array<{ actionId: string; status: string; text: string }> } } }).briefing?.primary?.receipts ?? [];
      const receipt = receipts.find((item) => item.actionId === actionId);
      roundTrip.push({ name: `${actionId}: DB row changed`, ok: !before && effects[actionId]!(), detail: `before ${before}, after ${effects[actionId]!()}` });
      roundTrip.push({ name: `${actionId}: succeeded receipt on the same surface`, ok: receipt?.status === "succeeded" && done.surface?.surfaceId === brief.surface?.surfaceId, detail: receipt?.text });
      roundTrip.push({ name: `${actionId}: receipt stamped with the demo clock`, ok: /07:00 IST|Assigned/.test(receipt?.text ?? ""), detail: receipt?.text });
    }
    const next = await runInvestigation({ question: BRIEF, threadId: "eval-roundtrip-after", principal: coo });
    const again = ((next.surface?.dataModel as { briefing?: Briefing }).briefing?.actions ?? []).filter((action) => action.name === "propose_action").map((action) => action.id);
    roundTrip.push({ name: "the next briefing offers none of the done operations", ok: again.length === 0, detail: again.join(", ") });
  } catch (error) {
    roundTrip.push({ name: "round-trip ran", ok: false, detail: error instanceof Error ? error.message : String(error) });
  }
}

// Report.
const cellPassed = (cell: Cell) => cell.checks.every((item) => item.ok);
const passed = cells.filter(cellPassed).length;
const roundTripPassed = roundTrip.every((item) => item.ok);
const checkCount = cells.reduce((sum, cell) => sum + cell.checks.length, 0) + roundTrip.length;
const failedChecks = cells.flatMap((cell) => cell.checks.filter((item) => !item.ok).map((item) => `${cell.scenario}/${cell.persona}/${cell.variant}#${cell.repeat}: ${item.name}${item.detail ? ` — ${item.detail}` : ""}`))
  .concat(roundTrip.filter((item) => !item.ok).map((item) => `round-trip: ${item.name}${item.detail ? ` — ${item.detail}` : ""}`));

console.log(`\neval:briefing · mode ${mode} · ${scenarios.length} scenarios × ${PERSONAS.length} personas × ${variants.length} variant(s) × ${repeats} repeat(s)\n`);
console.log(`${"scenario".padEnd(10)} ${"persona".padEnd(14)} ${"variant".padEnd(13)} ${"checks".padEnd(7)} title`);
for (const cell of cells) {
  const ok = cell.checks.filter((item) => item.ok).length;
  console.log(`${cell.scenario.padEnd(10)} ${cell.persona.padEnd(14)} ${cell.variant.padEnd(13)} ${`${ok}/${cell.checks.length}`.padEnd(7)} ${cellPassed(cell) ? "✓" : "✗"} ${cell.title}`);
}
console.log(`\nround-trip (hub-fault, COO): ${roundTrip.filter((item) => item.ok).length}/${roundTrip.length} ${roundTripPassed ? "✓" : "✗"}`);
for (const item of roundTrip) console.log(`  ${item.ok ? "✓" : "✗"} ${item.name}${item.ok ? "" : ` — ${item.detail ?? ""}`}`);
const rate = (passed / cells.length) * 100;
console.log(`\ncells passed: ${passed}/${cells.length} (${rate.toFixed(1)}%) · checks: ${checkCount - failedChecks.length}/${checkCount} · round-trip: ${roundTripPassed ? "pass" : "FAIL"}`);
if (failedChecks.length) console.log(`\nfailures:\n  ${failedChecks.join("\n  ")}`);

const reportPath = resolve(process.env.EVAL_REPORT ?? join(dirname(fileURLToPath(import.meta.url)), "../../../../test-results/eval-briefing.json"));
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, JSON.stringify({ mode, repeats, cellsPassed: passed, cells: cells.length, passRate: rate, checks: checkCount, failedChecks, roundTrip, results: cells }, null, 2));
console.log(`\nreport: ${reportPath}`);
store.close();

// Fixture mode is a gate (must be 100%); live-strict is reported, not enforced.
process.exit(mode === "fixture" && (failedChecks.length > 0) ? 1 : 0);
