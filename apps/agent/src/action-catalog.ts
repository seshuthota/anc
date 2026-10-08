import type { AgentFinding, EntityRef } from "@anc/contracts";
import { hasGrant, type CapabilityId, type Principal } from "@anc/policy";

/**
 * The typed catalog of operations a briefing may offer (R6). Pure data and pure
 * selection: no I/O, so the ranker can use it. The runtime flow that proposes,
 * confirms and cancels these lives in operations.ts.
 *
 * Out of scope on purpose: reroute, dispatch and redeliver stay refused by the
 * planner. Nothing here sends anything outside the demo database.
 */
export type CatalogActionId = "escalate_equipment_fault" | "notify_shipper" | "assign_complaints";

export type CatalogAction = {
  id: CatalogActionId;
  /** The record types the action is bound to (the runtime picks the record, never a model). */
  appliesTo: Array<EntityRef["type"]>;
  requiredGrant: CapabilityId;
  /** The company MCP write the confirm step runs. */
  tool: string;
  /** The read re-run after the write, whose result backs the receipt. */
  reread: string;
  sideEffect: "write";
  /** Shown in a refusal: "Not authorized to <verb>". */
  verb: string;
};

export const ACTION_CATALOG: readonly CatalogAction[] = [
  { id: "escalate_equipment_fault", appliesTo: ["equipment"], requiredGrant: "cap.equipment.escalate", tool: "escalate_equipment_fault", reread: "list_equipment_events", sideEffect: "write", verb: "escalate equipment faults" },
  { id: "notify_shipper", appliesTo: ["shipper"], requiredGrant: "cap.shippers.notify", tool: "notify_shipper", reread: "get_shipper", sideEffect: "write", verb: "notify shippers" },
  { id: "assign_complaints", appliesTo: ["complaint", "shipment"], requiredGrant: "cap.complaints.assign", tool: "commit_complaint_assignment", reread: "list_complaints", sideEffect: "write", verb: "assign complaints" },
];

export function catalogAction(id: string): CatalogAction | undefined {
  return ACTION_CATALOG.find((action) => action.id === id);
}

/** An action the ranker put on a briefing: which one, its button label, and the records it is bound to. */
export type PlannedAction = { id: CatalogActionId; label: string; entities: EntityRef[] };

/** "Hyderabad Hub: Sorter belt B fault" → "Sorter belt B". */
function equipmentName(finding: AgentFinding | undefined): string | undefined {
  const match = finding?.title.match(/:\s*(.+?)\s+(?:fault|stoppage|breakdown)\b/i);
  return match?.[1];
}

/**
 * Picks at most three catalog actions for a briefing, deterministically, from the
 * records on the primary card (the primary finding and the findings its cause
 * chain cites) and the person's grants. Catalog order is cause → customer → queue.
 * `completed` holds `<actionId>:<recordId>` pairs already done (an escalated fault),
 * which are not offered again.
 */
export function selectBriefingActions(input: {
  primary: AgentFinding;
  /** Findings on the primary card besides the primary (the chain's). */
  related: AgentFinding[];
  metricId?: string;
  principal?: Principal;
  completed?: ReadonlySet<string>;
}): PlannedAction[] {
  const { primary, related, principal } = input;
  const onCard = [primary, ...related];
  const granted = (action: CatalogAction) => !principal || hasGrant(principal, action.requiredGrant);
  const done = (id: CatalogActionId, recordId: string) => input.completed?.has(`${id}:${recordId}`) ?? false;
  const first = (type: EntityRef["type"]) => {
    for (const finding of onCard) {
      const entity = finding.entities.find((item) => item.type === type);
      if (entity) return { entity, finding };
    }
    return undefined;
  };
  const actions: PlannedAction[] = [];
  for (const action of ACTION_CATALOG) {
    if (!granted(action)) continue;
    if (action.id === "escalate_equipment_fault") {
      const hit = first("equipment");
      if (!hit || done(action.id, hit.entity.id)) continue;
      const name = equipmentName(hit.finding);
      actions.push({ id: action.id, label: name ? `Escalate ${name} fault` : "Escalate the equipment fault", entities: [{ type: "equipment", id: hit.entity.id, ...(name ? { label: name } : {}) }] });
    } else if (action.id === "notify_shipper") {
      const hit = first("shipper");
      if (!hit || done(action.id, hit.entity.id)) continue;
      actions.push({ id: action.id, label: `Notify ${hit.entity.label ?? hit.entity.id}`, entities: [{ type: "shipper", id: hit.entity.id, ...(hit.entity.label ? { label: hit.entity.label } : {}) }] });
    } else if (action.id === "assign_complaints") {
      // Late complaints are tied to parcels at risk today: offered when that is the
      // primary's figure. Which complaints is decided when it is proposed.
      if (input.metricId !== "parcels_at_risk_today" || done(action.id, "late-at-risk")) continue;
      actions.push({ id: action.id, label: "Assign late complaints", entities: [] });
    }
  }
  return actions.slice(0, 3);
}

/**
 * A Lead Analyst may reorder the planned actions but not add, drop or rename one.
 * Returns errors in review-feedback form; an empty list means the order is usable.
 */
export function reviewActionOrder(order: unknown, planned: PlannedAction[]): string[] {
  if (order === undefined) return [];
  if (!Array.isArray(order)) return ["actionOrder must be an array of the plan's action ids"];
  const ids = order.map(String);
  const expected = planned.map((action) => action.id as string);
  const errors: string[] = [];
  for (const id of ids) if (!expected.includes(id)) errors.push(`actionOrder names ${id}, which is not one of the plan's actions (${expected.join(", ") || "none"}); actions come from the catalog, not the analyst`);
  if (new Set(ids).size !== ids.length) errors.push("actionOrder repeats an action");
  for (const id of expected) if (!ids.includes(id)) errors.push(`actionOrder must keep every planned action; ${id} is missing`);
  return errors;
}

export function applyActionOrder(planned: PlannedAction[], order: string[] | undefined): PlannedAction[] {
  if (!order?.length) return planned;
  return [...planned].sort((left, right) => order.indexOf(left.id) - order.indexOf(right.id));
}
