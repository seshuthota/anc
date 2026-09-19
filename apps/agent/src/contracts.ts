export type SurfaceComponent =
  | { type: "metric"; id: string; label: string; value: string; detail: string; tone?: "danger" | "warning" | "neutral" }
  | { type: "finding"; id: string; title: string; body: string; evidence: string }
  | { type: "action"; id: string; label: string; intent: SemanticIntent };

export type SemanticIntent =
  | "investigate"
  | "show_affected_accounts"
  | "inspect_release"
  | "inspect_account"
  | "inspect_financial_impact"
  | "show_evidence"
  | "retry_task";

export interface A2UISurfaceFixture {
  surfaceId: string;
  revision: number;
  title: string;
  subtitle: string;
  components: SurfaceComponent[];
}

export interface SurfaceAction {
  actionId: string;
  surfaceId: string;
  surfaceRevision: number;
  intent: SemanticIntent;
  entityRefs?: Record<string, string>;
}

export interface ActivityEvent {
  id: string;
  message: string;
  timestamp: string;
}

export interface RuntimeState {
  investigationId: string;
  surface: A2UISurfaceFixture;
  activity: ActivityEvent[];
  handledActionIds: string[];
}
