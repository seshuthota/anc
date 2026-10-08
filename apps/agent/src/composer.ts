import { A2UI_CATALOG_ID, type A2UIMessage, type PresentationBriefing, type PresentationInput } from "@anc/contracts";

type Component = Record<string, unknown>;

/** A standard A2UI Button: the label is a child Text component, not a prop. */
function button(id: string, label: string, variant: "primary" | "borderless", action: Record<string, unknown>): Component[] {
  return [
    { id, component: "Button", child: `${id}_label`, variant, action },
    { id: `${id}_label`, component: "Text", text: label },
  ];
}

/**
 * Composes a workspace surface from verified presentation input.
 *
 * Layout follows `presentation.view`, which the planner already computes. The
 * composer only chooses among supported primitives and never reads company data
 * or calls a tool: it cannot invent a capability, a number, or an action.
 */
export function composeA2UI(surfaceId: string, presentation: PresentationInput): { messages: A2UIMessage[]; dataModel: Record<string, unknown> } {
  if (presentation.briefing) return composeBriefing(surfaceId, presentation, presentation.briefing);
  const view = presentation.view;
  const components: Component[] = [];
  const rootChildren: string[] = ["header"];

  // With a connected account, the headline is followed by the account itself, not by one finding's detail.
  components.push({ id: "header", component: "Column", children: presentation.synthesis ? ["title"] : ["title", "subtitle"] });
  components.push({ id: "title", component: "Text", text: { path: "/title" }, variant: "h2" });
  components.push({ id: "subtitle", component: "Text", text: { path: "/subtitle" } });

  if (presentation.synthesis) {
    // The connected account leads; individual findings follow as its support.
    const { steps, separate } = presentation.synthesis;
    rootChildren.push("story");
    components.push({ id: "story", component: "Column", children: ["story_chain", ...(separate.length ? ["story_separate_label", ...separate.map((item) => `story_${item.id}`)] : [])] });
    components.push({ id: "story_chain", component: "Sequence", children: steps.map((step) => `story_${step.id}_stop`) });
    for (const step of steps) {
      components.push({ id: `story_${step.id}_stop`, component: "Column", children: [`story_${step.id}`, `story_${step.id}_kind`] });
      components.push({ id: `story_${step.id}`, component: "Text", text: { path: `/synthesis/steps/${step.id}/text` } });
      components.push({ id: `story_${step.id}_kind`, component: "Text", text: { path: `/synthesis/steps/${step.id}/kindLabel` }, variant: "caption" });
    }
    if (separate.length) components.push({ id: "story_separate_label", component: "Text", text: "Separate from this", variant: "h4" });
    for (const item of separate) components.push({ id: `story_${item.id}`, component: "Text", text: { path: `/synthesis/separate/${item.id}/text` } });
  }

  const showMetrics = view !== "table" && view !== "form" && presentation.metrics.length > 0;
  if (showMetrics) {
    rootChildren.push("metrics_row");
    components.push({ id: "metrics_row", component: "Row", children: presentation.metrics.map((metric) => `metric_${metric.id}`) });
    for (const metric of presentation.metrics) {
      components.push({ id: `metric_${metric.id}`, component: "Stat", label: { path: `/metrics/${metric.id}/label` }, value: { path: `/metrics/${metric.id}/value` }, tone: metric.tone === "danger" ? "alert" : "neutral" });
    }
  }

  if (presentation.chart) {
    rootChildren.push("chart_block");
    components.push({ id: "chart_block", component: "Column", children: ["chart"] });
    components.push({
      id: "chart",
      component: "Chart",
      title: { path: "/chart/title" },
      unit: presentation.chart.unit,
      points: { path: "/chart/points" },
      ...(presentation.chart.caption ? { caption: { path: "/chart/caption" } } : {}),
    });
  }

  if (view !== "form" && presentation.findings.length) {
    rootChildren.push("findings");
    components.push({ id: "findings", component: "Column", children: presentation.findings.map((item) => `finding_${item.id}`) });
    for (const item of presentation.findings) {
      components.push({ id: `finding_${item.id}`, component: "Card", child: `finding_${item.id}_col` });
      components.push({ id: `finding_${item.id}_col`, component: "Column", children: [`finding_${item.id}_title`, `finding_${item.id}_body`, `finding_${item.id}_kind`, `finding_${item.id}_evidence`] });
      components.push({ id: `finding_${item.id}_title`, component: "Text", text: { path: `/findings/${item.id}/title` } });
      components.push({ id: `finding_${item.id}_body`, component: "Text", text: { path: `/findings/${item.id}/body` } });
      components.push({ id: `finding_${item.id}_kind`, component: "Text", text: { path: `/findings/${item.id}/kindLabel` }, variant: "caption" });
      components.push(...button(`finding_${item.id}_evidence`, "View evidence", "borderless", { event: { name: "show_evidence", context: { evidenceIds: item.evidenceIds } } }));
    }
  }

  if (presentation.table) {
    rootChildren.push("table_block");
    const totals = presentation.table.totals?.length ? ["Totals", ...presentation.table.totals] : undefined;
    components.push({
      id: "table_block",
      component: "Table",
      columns: { path: "/table/columns" },
      rows: { path: "/table/rows" },
      ...(totals ? { totals: { path: "/table/totals" } } : {}),
      ...(presentation.table.defaultSort === undefined ? {} : { defaultSort: presentation.table.defaultSort }),
      ...(presentation.table.completeness ? { completeness: presentation.table.completeness } : {}),
      rowActionLabel: view === "queue" ? "Work" : "Open",
    });
  }

  if (presentation.draft) {
    const draftId = presentation.draft.id;
    rootChildren.push("draft_block");
    components.push({ id: "draft_block", component: "Column", children: ["draft_title", "draft_status", ...presentation.draft.steps.flatMap((_, index) => [`draft_text_${index}`, `draft_done_${index}`]), "draft_assumptions", "draft_save"] });
    components.push({ id: "draft_title", component: "Text", text: { path: "/draft/title" }, variant: "h3" });
    components.push({ id: "draft_status", component: "Text", text: { path: "/draft/statusLabel" }, variant: "caption" });
    presentation.draft.steps.forEach((step, index) => {
      components.push({
        id: `draft_text_${index}`,
        component: "EditField",
        fieldId: `draft_text_${step.id}`,
        label: { path: `/draft/steps/${index}/label` },
        value: { path: `/draft/steps/${index}/text` },
      });
      components.push({
        id: `draft_done_${index}`,
        component: "SelectOption",
        groupId: draftId,
        optionId: step.id,
        text: { path: `/draft/steps/${index}/doneLabel` },
        selected: { path: "/draft/completed" },
        actionName: "set_selection",
      });
    });
    components.push({ id: "draft_assumptions", component: "Text", text: { path: "/draft/assumptionsLabel" }, variant: "caption" });
    components.push(...button("draft_save", "Save draft", "primary", { event: { name: "save_draft", context: { draftId } } }));
  }

  if (presentation.form) {
    const formChildren = ["form_title"];
    rootChildren.push("form_block");
    components.push({ id: "form_title", component: "Text", text: "Review and confirm", variant: "h3" });
    for (const field of presentation.form.fields) {
      formChildren.push(`field_${field.id}`);
      if (field.options?.length) {
        components.push({ id: `field_${field.id}`, component: "Column", children: [`field_${field.id}_label`, ...field.options.map((option) => `opt_${field.id}_${option.id}`)] });
        components.push({ id: `field_${field.id}_label`, component: "Text", text: field.label, variant: "caption" });
        for (const option of field.options) {
          components.push(...button(`opt_${field.id}_${option.id}`, option.label, "borderless", { event: { name: "select_assignee", context: { [field.name]: option.id, label: option.label, proposalId: presentation.form.id } } }));
        }
      } else {
        components.push({ id: `field_${field.id}`, component: "Text", text: field.value ? `${field.label}: ${field.value}` : field.label });
      }
    }
    formChildren.push("form_submit");
    components.push(...button("form_submit", presentation.form.submitLabel, "primary", { event: { name: presentation.form.submitAction, context: { proposalId: presentation.form.id } } }));
    components.push({ id: "form_block", component: "Column", children: formChildren });
  }

  if (presentation.selection) {
    rootChildren.push("selection_block");
    components.push({ id: "selection_block", component: "Column", children: ["selection_label", ...presentation.selection.options.map((option) => `sel_${option.id}`)] });
    components.push({ id: "selection_label", component: "Text", text: { path: "/selection/label" }, variant: "caption" });
    for (const option of presentation.selection.options) {
      components.push({
        id: `sel_${option.id}`,
        component: "SelectOption",
        groupId: presentation.selection.id,
        optionId: option.id,
        text: { path: `/selection/options/${option.id}/label` },
        selected: { path: "/selection/selected" },
        actionName: "set_selection",
      });
    }
  }

  if (presentation.receipt) {
    rootChildren.push("receipt_block");
    components.push({ id: "receipt_block", component: "Text", text: { path: "/receipt" }, variant: "caption" });
  }

  if (presentation.actions.length) {
    rootChildren.push("actions");
    components.push({ id: "actions", component: "Row", children: presentation.actions.map((action) => `action_${action.id}`) });
    for (const action of presentation.actions) {
      components.push(...button(`action_${action.id}`, action.label, "primary", { event: { name: action.name, context: { entities: action.entities } } }));
    }
  }

  if (presentation.limitations.length) {
    rootChildren.push("limits");
    components.push({ id: "limits", component: "Text", text: { path: "/limitations" }, variant: "caption" });
  }

  components.unshift({ id: "root", component: "Column", children: rootChildren });

  const dataModel: Record<string, unknown> = {
    title: presentation.title,
    subtitle: presentation.subtitle,
    view,
    synthesis: presentation.synthesis ? {
      headline: presentation.synthesis.headline,
      steps: Object.fromEntries(presentation.synthesis.steps.map((step, index) => [step.id, {
        order: index + 1,
        text: step.text,
        kind: step.kind,
        // Stated so the analyst's own reasoning never reads as an observed fact.
        kindLabel: step.kind === "observed" ? "Observed" : "Inferred link, not confirmed",
        evidenceIds: step.evidenceIds,
      }])),
      separate: Object.fromEntries(presentation.synthesis.separate.map((item) => [item.id, { text: item.text, evidenceIds: item.evidenceIds }])),
    } : undefined,
    // R4: every figure sits next to the evidence it was read from.
    metrics: Object.fromEntries(presentation.metrics.map((metric) => [metric.id, { ...metric, evidenceIds: [metric.evidenceId] }])),
    findings: Object.fromEntries(presentation.findings.map((item) => [item.id, {
      ...item,
      // Surfaced in business language so an unproven cause cannot read as fact.
      kindLabel: item.kind === "observation"
        ? "Observed"
        : item.kind === "hypothesis"
          ? "Hypothesis, not confirmed"
          : "Open question",
    }])),
    table: presentation.table ? {
      columns: presentation.table.columns,
      rows: presentation.table.rows,
      totals: presentation.table.totals,
    } : undefined,
    limitations: presentation.limitations.join(" "),
    form: presentation.form,
    receipt: presentation.receipt ? `${presentation.receipt.status}: ${presentation.receipt.summary}` : "",
  };

  if (presentation.chart) {
    dataModel.chart = {
      title: presentation.chart.title,
      unit: presentation.chart.unit,
      points: presentation.chart.points,
      caption: presentation.chart.caption ?? "",
    };
  }

  if (presentation.draft) {
    const completed = presentation.draft.steps.filter((step) => step.done).map((step) => step.id);
    dataModel.draft = {
      id: presentation.draft.id,
      title: presentation.draft.title,
      status: presentation.draft.status,
      statusLabel: presentation.draft.status === "confirmed"
        ? "Confirmed by an authorized user."
        : "Model-authored draft. Not an observed fact and not an executed action.",
      assumptions: presentation.draft.assumptions,
      assumptionsLabel: presentation.draft.assumptions.length
        ? `Assumptions this draft does not verify: ${presentation.draft.assumptions.join(" ")}`
        : "No assumptions were recorded for this draft.",
      completed,
      steps: presentation.draft.steps.map((step, index) => ({
        id: step.id,
        label: `Step ${index + 1}`,
        text: step.text,
        doneLabel: step.done ? "Done" : "Mark done",
      })),
    };
  }

  if (presentation.selection) {
    dataModel.selection = {
      id: presentation.selection.id,
      label: presentation.selection.label,
      selected: presentation.selection.selected,
      options: Object.fromEntries(presentation.selection.options.map((option) => [option.id, { label: option.label }])),
    };
  }

  const messages: A2UIMessage[] = [
    { version: "v0.9", createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: dataModel } },
  ];
  return { messages, dataModel };
}

/**
 * The budgeted briefing layout (R3): exactly one PrimaryFinding (none on a quiet
 * day), at most three action buttons, at most one Collapsible holding at most
 * three secondary items, and no free Stat tiles, finding cards or Sequence.
 * The fallback for a rejected model layout is this same layout, so the budget holds either way.
 */
function composeBriefing(surfaceId: string, presentation: PresentationInput, briefing: PresentationBriefing): { messages: A2UIMessage[]; dataModel: Record<string, unknown> } {
  const components: Component[] = [];
  const rootChildren: string[] = [];
  const secondary = briefing.secondary.slice(0, 3);
  const actions = briefing.actions.slice(0, 3);

  if (briefing.primary) {
    rootChildren.push("primary_block");
    components.push({ id: "primary_block", component: "PrimaryFinding", finding: { path: "/briefing/primary" } });
  } else {
    rootChildren.push("header");
    components.push({ id: "header", component: "Column", children: ["title", "calm"] });
    components.push({ id: "title", component: "Text", text: { path: "/title" }, variant: "h2" });
    components.push({ id: "calm", component: "Text", text: { path: "/briefing/quiet/label" } });
  }

  if (briefing.primary && actions.length) {
    rootChildren.push("actions");
    components.push({ id: "actions", component: "Row", children: actions.map((action) => `action_${action.id}`) });
    for (const action of actions) {
      const context = action.name === "investigate" ? { question: action.question ?? action.label } : { entities: action.entities };
      components.push(...button(`action_${action.id}`, action.label, "primary", { event: { name: action.name, context } }));
    }
  }

  if (secondary.length) {
    rootChildren.push("rest");
    components.push({ id: "rest", component: "Collapsible", summary: { path: "/briefing/restLabel" }, child: "rest_items" });
    components.push({ id: "rest_items", component: "Column", children: secondary.map((item) => `rest_${item.id}`) });
    for (const item of secondary) {
      components.push({ id: `rest_${item.id}`, component: "Row", align: "center", justify: "spaceBetween", children: [`rest_${item.id}_title`, `rest_${item.id}_buttons`] });
      components.push({ id: `rest_${item.id}_title`, component: "Text", text: { path: `/briefing/secondary/${item.id}/title` } });
      components.push({ id: `rest_${item.id}_buttons`, component: "Row", children: [`rest_${item.id}_drill`, `rest_${item.id}_evidence`] });
      components.push(...button(`rest_${item.id}_drill`, "Look into this", "borderless", { event: { name: "investigate", context: { question: item.question } } }));
      components.push(...button(`rest_${item.id}_evidence`, "Evidence", "borderless", { event: { name: "show_evidence", context: { evidenceIds: item.evidenceIds, ...(item.metricId ? { metricId: item.metricId } : {}), ...(item.resultPath ? { resultPath: item.resultPath } : {}) } } }));
    }
  }

  if (presentation.limitations.length) {
    rootChildren.push("limits");
    components.push({ id: "limits", component: "Text", text: { path: "/limitations" }, variant: "caption" });
  }

  components.unshift({ id: "root", component: "Column", children: rootChildren });

  const dataModel: Record<string, unknown> = {
    title: presentation.title,
    subtitle: presentation.subtitle,
    view: "summary",
    briefing: {
      primary: briefing.primary ? {
        ...briefing.primary,
        chain: briefing.primary.chain.map((hop) => ({ ...hop, kindLabel: hop.kind === "observed" ? "Observed" : "Inferred link, not confirmed" })),
        confidenceLabel: `Confidence: ${briefing.primary.confidence[0]!.toUpperCase()}${briefing.primary.confidence.slice(1)}`,
      } : undefined,
      secondary: Object.fromEntries(secondary.map((item) => [item.id, item])),
      quiet: briefing.quiet,
      restLabel: briefing.restLabel ?? "",
      actions,
    },
    metrics: {},
    findings: {},
    limitations: presentation.limitations.join(" "),
  };

  const messages: A2UIMessage[] = [
    { version: "v0.9", createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: dataModel } },
  ];
  return { messages, dataModel };
}
