import type { A2UISurfaceFixture, RuntimeState, SurfaceAction } from "./contracts.js";

export const fixtureSurface: A2UISurfaceFixture = {
  surfaceId: "fixture-morning-brief",
  revision: 1,
  title: "Good morning",
  subtitle: "A fixture investigation is ready for review.",
  components: [
    { type: "metric", id: "errors", label: "API error rate", value: "5.8%", detail: "up from 0.7% yesterday", tone: "danger" },
    { type: "metric", id: "usage", label: "Sync usage", value: "−19%", detail: "compared with the prior period", tone: "warning" },
    { type: "metric", id: "accounts", label: "Accounts in scope", value: "14", detail: "$2.1M ARR represented" },
    { type: "finding", id: "release", title: "A recent release lines up with the change", body: "The synchronization error signature began after release-2026-09-19-3 reached the affected cohort.", evidence: "release timeline · error metrics" },
    { type: "action", id: "affected", label: "Show affected accounts", intent: "show_affected_accounts" },
  ],
};

export function createFixtureState(): RuntimeState {
  return { investigationId: "morning-brief-fixture", surface: structuredClone(fixtureSurface), activity: [], handledActionIds: [] };
}

/**
 * Fixture-only surface transition. Replace this boundary with the selected A2UI
 * renderer/catalog and AG-UI event transport during M0 integration validation.
 */
export function applySurfaceAction(state: RuntimeState, action: SurfaceAction): RuntimeState {
  if (state.handledActionIds.includes(action.actionId)) return state;
  if (action.surfaceId !== state.surface.surfaceId || action.surfaceRevision !== state.surface.revision) {
    throw new Error("stale surface action");
  }
  const message = `Action received: ${action.intent}`;
  const nextSurface = { ...state.surface, revision: state.surface.revision + 1, subtitle: action.intent === "show_affected_accounts" ? "Affected accounts are available through the investigation runtime." : state.surface.subtitle };
  return { ...state, surface: nextSurface, handledActionIds: [...state.handledActionIds, action.actionId], activity: [{ id: crypto.randomUUID(), message, timestamp: new Date().toISOString() }, ...state.activity] };
}
