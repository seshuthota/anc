import { A2UI_CATALOG_ID, type A2UIMessage, type PresentationInput } from "@anc/contracts";

type Component = Record<string, unknown>;

/**
 * Composes a workspace surface from verified presentation input.
 *
 * Layout follows `presentation.view`, which the planner already computes. The
 * composer only chooses among supported primitives and never reads company data
 * or calls a tool: it cannot invent a capability, a number, or an action.
 */
export function composeA2UI(surfaceId: string, presentation: PresentationInput): { messages: A2UIMessage[]; dataModel: Record<string, unknown> } {
  const view = presentation.view;
  const components: Component[] = [];
  const rootChildren: string[] = [];

  // Header is earned by non-empty title/subtitle from verified presentation — never chrome-only.
  const hasTitle = Boolean(presentation.title?.trim());
  const hasSubtitle = Boolean(presentation.subtitle?.trim());
  if (hasTitle || hasSubtitle) {
    const headerChildren: string[] = [];
    if (hasTitle) {
      headerChildren.push("title");
      components.push({ id: "title", component: "Text", text: { path: "/title" }, variant: "h2" });
    }
    if (hasSubtitle) {
      headerChildren.push("subtitle");
      components.push({ id: "subtitle", component: "Text", text: { path: "/subtitle" } });
    }
    rootChildren.push("header");
    components.push({ id: "header", component: "Column", children: headerChildren });
  }

  const showMetrics = view !== "table" && view !== "form" && presentation.metrics.length > 0;
  if (showMetrics) {
    rootChildren.push("metrics_row");
    components.push({ id: "metrics_row", component: "Row", children: presentation.metrics.map((metric) => `metric_${metric.id}`) });
    for (const metric of presentation.metrics) {
      components.push({ id: `metric_${metric.id}`, component: "Card", child: `metric_${metric.id}_col` });
      components.push({ id: `metric_${metric.id}_col`, component: "Column", children: [`metric_${metric.id}_label`, `metric_${metric.id}_value`, `metric_${metric.id}_detail`] });
      components.push({ id: `metric_${metric.id}_label`, component: "Text", text: { path: `/metrics/${metric.id}/label` }, variant: "caption" });
      components.push({ id: `metric_${metric.id}_value`, component: "Text", text: { path: `/metrics/${metric.id}/value` }, variant: "h3" });
      components.push({ id: `metric_${metric.id}_detail`, component: "Button", text: { path: `/metrics/${metric.id}/detail` }, variant: "borderless", action: { event: { name: "show_evidence", context: { evidenceId: metric.evidenceId } } } });
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
      caption: presentation.chart.caption ? { path: "/chart/caption" } : undefined,
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
      components.push({ id: `finding_${item.id}_evidence`, component: "Button", text: "View evidence", variant: "borderless", action: { event: { name: "show_evidence", context: { evidenceIds: item.evidenceIds } } } });
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
      totals: totals ? { path: "/table/totals" } : undefined,
      defaultSort: presentation.table.defaultSort,
      completeness: presentation.table.completeness,
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
        component: "TextField",
        label: { path: `/draft/steps/${index}/label` },
        value: { path: `/draft/steps/${index}/text` },
      });
      components.push({
        id: `draft_done_${index}`,
        component: "Checkbox",
        groupId: draftId,
        optionId: step.id,
        text: { path: `/draft/steps/${index}/doneLabel` },
        selected: { path: "/draft/completed" },
        actionName: "set_selection",
      });
    });
    components.push({ id: "draft_assumptions", component: "Text", text: { path: "/draft/assumptionsLabel" }, variant: "caption" });
    components.push({ id: "draft_save", component: "Button", text: "Save draft", action: { event: { name: "save_draft", context: { draftId } } } });
  }

  if (presentation.form) {
    const formChildren = ["form_title"];
    rootChildren.push("form_block");
    components.push({ id: "form_title", component: "Text", text: "Review and confirm", variant: "h3" });
    for (const field of presentation.form.fields) {
      formChildren.push(`field_${field.id}`);
      if (field.options?.length) {
        components.push({ id: `field_${field.id}`, component: "Column", children: [`field_${field.id}_label`, ...field.options.map((option) => `opt_${field.id}_${option.id}`)] });
        components.push({ id: `field_${field.id}_label`, component: "Text", text: { path: `/form/fields/${field.id}/label` }, variant: "caption" });
        for (const option of field.options) {
          components.push({
            id: `opt_${field.id}_${option.id}`,
            component: "Button",
            text: { path: `/form/fields/${field.id}/options/${option.id}/label` },
            variant: "borderless",
            action: { event: { name: "select_assignee", context: { [field.name]: option.id, label: option.label, proposalId: { path: "/form/id" } } } },
          });
        }
      } else {
        components.push({ id: `field_${field.id}`, component: "Text", text: { path: `/form/fields/${field.id}/display` } });
      }
    }
    formChildren.push("form_submit");
    components.push({
      id: "form_submit",
      component: "Button",
      text: { path: "/form/submitLabel" },
      action: { event: { name: { path: "/form/submitAction" }, context: { proposalId: { path: "/form/id" } } } },
    });
    components.push({ id: "form_block", component: "Column", children: formChildren });
  }

  if (presentation.selection) {
    rootChildren.push("selection_block");
    components.push({ id: "selection_block", component: "Column", children: ["selection_label", ...presentation.selection.options.map((option) => `sel_${option.id}`)] });
    components.push({ id: "selection_label", component: "Text", text: { path: "/selection/label" }, variant: "caption" });
    for (const option of presentation.selection.options) {
      components.push({
        id: `sel_${option.id}`,
        component: "Checkbox",
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
      components.push({
        id: `action_${action.id}`,
        component: "Button",
        text: action.label,
        variant: "primary",
        action: { event: { name: action.name, context: { entities: action.entities } } },
      });
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
    metrics: Object.fromEntries(presentation.metrics.map((metric) => [metric.id, metric])),
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
