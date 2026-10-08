import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { publicState, restoreSurface, runInvestigation, store } from "./runtime.js";
import { DEFAULT_THREAD_ID } from "./windows.js";
import { migrateCompanyDatabase } from "./mcp-client.js";

const [command, ...rest] = process.argv.slice(2);

type Component = { id?: string; component?: string; label?: unknown };

function componentsOf(messages: unknown): Component[] {
  if (!Array.isArray(messages)) return [];
  for (const message of messages) {
    if (message && typeof message === "object" && "updateComponents" in message) {
      const update = (message as { updateComponents?: { components?: unknown } }).updateComponents;
      if (Array.isArray(update?.components)) return update.components as Component[];
    }
  }
  return [];
}

function labelText(label: unknown, dataModel: Record<string, unknown>): string | undefined {
  if (typeof label === "string") return label;
  if (label && typeof label === "object" && "path" in label && typeof (label as { path: unknown }).path === "string") {
    const path = (label as { path: string }).path.replace(/^\//, "").split("/");
    let cursor: unknown = dataModel;
    for (const part of path) {
      if (!cursor || typeof cursor !== "object") return undefined;
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return typeof cursor === "string" ? cursor : undefined;
  }
  return undefined;
}

function inspectSurface(state: ReturnType<typeof publicState>) {
  const components = componentsOf(state.surface?.messages);
  const dataModel = (state.surface?.dataModel && typeof state.surface.dataModel === "object"
    ? state.surface.dataModel
    : {}) as Record<string, unknown>;
  const fromModel = dataModel.metrics && typeof dataModel.metrics === "object"
    ? Object.values(dataModel.metrics as Record<string, { label?: string }>).map((metric) => metric.label).filter((label): label is string => Boolean(label))
    : [];
  const fromStats = components
    .filter((component) => component.component === "Stat")
    .map((component) => labelText(component.label, dataModel))
    .filter((label): label is string => Boolean(label));
  const metricLabels = fromModel.length ? fromModel : fromStats;
  const contradictionLines = state.activity
    .map((item) => item.message)
    .filter((message) => /contradict/i.test(message));
  const primaryFindings = components.filter((component) => component.component === "PrimaryFinding").length;
  const byId = new Map(components.map((component) => [String(component.id), component]));
  const subtree = (id: string, out = new Set<string>()): Set<string> => {
    const component = byId.get(id) as (Component & { child?: unknown; children?: unknown }) | undefined;
    if (!component || out.has(id)) return out;
    out.add(id);
    const kids = [...(Array.isArray(component.children) ? component.children.map(String) : []), ...(typeof component.child === "string" ? [component.child] : [])];
    for (const kid of kids) subtree(kid, out);
    return out;
  };
  const collapsibles = components.filter((component) => component.component === "Collapsible");
  const inside = new Set<string>();
  for (const collapsible of collapsibles) subtree(String(collapsible.id), inside);
  const eventName = (component: Component) => ((component as { action?: { event?: { name?: string } } }).action?.event?.name);
  const briefing = dataModel.briefing as { primary?: { metric?: { metricId?: string; label?: string; value?: string; definition?: string; windowLabel?: string; denominatorLabel?: string; evidenceIds?: string[]; resultPath?: string } }; secondary?: Record<string, { title?: string }>; quiet?: { label?: string } } | undefined;
  const metricsModel = dataModel.metrics && typeof dataModel.metrics === "object"
    ? Object.values(dataModel.metrics as Record<string, { metricId?: string; label?: string; value?: string; detail?: string }>)
    : [];
  const briefingMetric = briefing?.primary?.metric;
  const primaryMetric = briefingMetric
    ? { metricId: briefingMetric.metricId ?? null, label: briefingMetric.label ?? null, value: briefingMetric.value ?? null, detail: [briefingMetric.definition, briefingMetric.windowLabel, briefingMetric.denominatorLabel].filter(Boolean).join(" · "), evidenceIds: briefingMetric.evidenceIds ?? [], resultPath: briefingMetric.resultPath ?? null }
    : metricsModel[0]
      ? { metricId: metricsModel[0].metricId ?? null, label: metricsModel[0].label ?? null, value: metricsModel[0].value ?? null, detail: metricsModel[0].detail ?? null }
      : null;
  return {
    title: state.surface?.title ?? null,
    status: state.status,
    componentCount: components.length,
    cards: components.filter((component) => component.component === "Card").length,
    stats: components.filter((component) => component.component === "Stat").length,
    buttons: components.filter((component) => component.component === "Button").length,
    actionButtons: components.filter((component) => component.component === "Button" && !inside.has(String(component.id)) && eventName(component) !== "show_evidence").length,
    primaryFindings,
    collapsibles: collapsibles.length,
    collapsedItems: Object.keys(briefing?.secondary ?? {}).length,
    collapsedTitles: Object.values(briefing?.secondary ?? {}).map((item) => item.title ?? ""),
    calmLine: briefing && !briefing.primary ? briefing.quiet?.label ?? null : null,
    metricLabels,
    headlineMetricCount: briefingMetric ? 1 : metricsModel.length,
    primaryMetric,
    contradictionActivityLines: contradictionLines,
    hasPrimaryFinding: primaryFindings > 0,
  };
}

async function main() {
  migrateCompanyDatabase();
  if (command === "investigate") {
    const question = rest.filter((item) => item !== "--" && item !== "--write").join(" ").trim() || "Brief me: what needs my attention this morning?";
    const state = await runInvestigation({ question, threadId: DEFAULT_THREAD_ID });
    console.log(JSON.stringify({ status: state.status, investigationId: state.investigationId, runId: state.runId, surface: state.surface?.title, activity: state.activity.slice(0, 12) }, null, 2));
    return;
  }
  if (command === "replay") {
    const runFlag = rest.indexOf("--run");
    const threadId = DEFAULT_THREAD_ID;
    const history = store.listSurfaces(threadId);
    const target = runFlag >= 0 ? history.find((item) => item.surfaceId.includes(String(rest[runFlag + 1]))) ?? history[0] : history[0];
    if (!target) {
      console.error("No saved surface to replay.");
      process.exitCode = 1;
      return;
    }
    const state = restoreSurface(threadId, target.surfaceId, target.revision);
    console.log(JSON.stringify({ replayed: target, surface: state.surface?.title, status: state.status }, null, 2));
    return;
  }
  if (command === "inspect") {
    const writeFlag = rest.indexOf("--write");
    const questionParts = rest.filter((item, index) => item !== "--" && item !== "--write" && !(writeFlag >= 0 && index === writeFlag + 1));
    const question = questionParts.join(" ").trim() || "Brief me: what needs my attention this morning?";
    if (!process.env.RUNTIME_DB_PATH) {
      console.error("inspect requires RUNTIME_DB_PATH to point at a temporary runtime database.");
      process.exitCode = 1;
      return;
    }
    const state = await runInvestigation({ question, threadId: DEFAULT_THREAD_ID });
    const stats = inspectSurface(state);
    console.log(JSON.stringify(stats, null, 2));
    if (writeFlag >= 0) {
      const dest = rest[writeFlag + 1];
      if (!dest) {
        console.error("Usage: inspect [question] --write <path>");
        process.exitCode = 1;
        return;
      }
      const path = resolve(dest);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, `${JSON.stringify(stats, null, 2)}\n`);
    }
    return;
  }
  console.error("Usage: tsx src/cli.ts investigate [question] | replay [--run id] | inspect [question] [--write path]");
  process.exitCode = 1;
}

await main();
