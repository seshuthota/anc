import { A2UI_CATALOG_ID, type A2UIMessage, type PresentationInput } from "@anc/contracts";

export function composeA2UI(surfaceId: string, presentation: PresentationInput): { messages: A2UIMessage[]; dataModel: Record<string, unknown> } {
  const formComponents: Array<Record<string, unknown>> = [];
  if (presentation.form) {
    formComponents.push({ id: "form_title", component: "Text", text: "Review and confirm", variant: "h3" });
    for (const field of presentation.form.fields) {
      if (field.options?.length) {
        formComponents.push({ id: `field_${field.id}`, component: "Column", children: [`field_${field.id}_label`, ...field.options.map((option) => `opt_${field.id}_${option.id}`)] });
        formComponents.push({ id: `field_${field.id}_label`, component: "Text", text: field.label, variant: "caption" });
        for (const option of field.options) {
          formComponents.push({
            id: `opt_${field.id}_${option.id}`,
            component: "Button",
            text: option.label,
            variant: "borderless",
            action: { event: { name: "select_assignee", context: { [field.name]: option.id, label: option.label, proposalId: presentation.form.id } } },
          });
        }
      } else {
        formComponents.push({ id: `field_${field.id}`, component: "Text", text: `${field.label}: ${field.value ?? ""}` });
      }
    }
    formComponents.push({
      id: "form_submit",
      component: "Button",
      text: presentation.form.submitLabel,
      action: { event: { name: presentation.form.submitAction, context: { proposalId: presentation.form.id } } },
    });
  }
  const components: Array<Record<string, unknown>> = [
    { id: "root", component: "Column", children: ["header", "metrics_row", "findings", "table_block", "form_block", "receipt_block", "actions", "limits"] },
    { id: "header", component: "Column", children: ["title", "subtitle"] },
    { id: "title", component: "Text", text: { path: "/title" }, variant: "h2" },
    { id: "subtitle", component: "Text", text: { path: "/subtitle" } },
    { id: "metrics_row", component: "Row", children: presentation.metrics.map((metric) => `metric_${metric.id}`) },
    ...presentation.metrics.flatMap((metric) => ([
      { id: `metric_${metric.id}`, component: "Card", child: `metric_${metric.id}_col` },
      { id: `metric_${metric.id}_col`, component: "Column", children: [`metric_${metric.id}_label`, `metric_${metric.id}_value`, `metric_${metric.id}_detail`] },
      { id: `metric_${metric.id}_label`, component: "Text", text: { path: `/metrics/${metric.id}/label` }, variant: "caption" },
      { id: `metric_${metric.id}_value`, component: "Text", text: { path: `/metrics/${metric.id}/value` }, variant: "h3" },
      { id: `metric_${metric.id}_detail`, component: "Button", text: { path: `/metrics/${metric.id}/detail` }, variant: "borderless", action: { event: { name: "show_evidence", context: { evidenceId: metric.evidenceId } } } },
    ])),
    { id: "findings", component: "Column", children: presentation.findings.map((item) => `finding_${item.id}`) },
    ...presentation.findings.flatMap((item) => ([
      { id: `finding_${item.id}`, component: "Card", child: `finding_${item.id}_col` },
      { id: `finding_${item.id}_col`, component: "Column", children: [`finding_${item.id}_title`, `finding_${item.id}_body`, `finding_${item.id}_evidence`] },
      { id: `finding_${item.id}_title`, component: "Text", text: { path: `/findings/${item.id}/title` } },
      { id: `finding_${item.id}_body`, component: "Text", text: { path: `/findings/${item.id}/body` } },
      { id: `finding_${item.id}_evidence`, component: "Button", text: "View evidence", variant: "borderless", action: { event: { name: "show_evidence", context: { evidenceIds: item.evidenceIds } } } },
    ])),
    { id: "table_block", component: "Column", children: presentation.table ? ["table_header", "table_list"] : [] },
    ...(presentation.table ? [
      { id: "table_header", component: "Text", text: { path: "/table/columns" } },
      { id: "table_list", component: "List", children: { path: "/table/rows", componentId: "table_row" } },
      { id: "table_row", component: "Button", text: { path: "label" }, action: { event: { name: { path: "actionName" }, context: { entityType: { path: "entityType" }, entityId: { path: "entityId" }, actionName: { path: "actionName" } } } } },
    ] : []),
    { id: "form_block", component: "Column", children: presentation.form ? ["form_title", ...presentation.form.fields.map((field) => `field_${field.id}`), "form_submit"] : [] },
    ...formComponents,
    { id: "receipt_block", component: "Text", text: { path: "/receipt" }, variant: "caption" },
    { id: "actions", component: "Row", children: presentation.actions.map((action) => `action_${action.id}`) },
    ...presentation.actions.map((action) => ({
      id: `action_${action.id}`,
      component: "Button",
      text: action.label,
      variant: "primary",
      action: { event: { name: action.name, context: { entities: action.entities } } },
    })),
    { id: "limits", component: "Text", text: { path: "/limitations" }, variant: "caption" },
  ];

  const dataModel = {
    title: presentation.title,
    subtitle: presentation.subtitle,
    metrics: Object.fromEntries(presentation.metrics.map((metric) => [metric.id, metric])),
    findings: Object.fromEntries(presentation.findings.map((item) => [item.id, item])),
    table: presentation.table ? {
      columns: presentation.table.columns.join(" · "),
      rows: presentation.table.rows.map((row) => ({
        ...row,
        label: row.cells.join("   "),
        actionName: row.actionName ?? "show_evidence",
      })),
    } : undefined,
    limitations: presentation.limitations.join(" "),
    form: presentation.form,
    receipt: presentation.receipt ? `${presentation.receipt.status}: ${presentation.receipt.summary}` : "",
  };

  const messages: A2UIMessage[] = [
    { version: "v0.9", createSurface: { surfaceId, catalogId: A2UI_CATALOG_ID } },
    { version: "v0.9", updateComponents: { surfaceId, components } },
    { version: "v0.9", updateDataModel: { surfaceId, path: "/", value: dataModel } },
  ];
  return { messages, dataModel };
}
