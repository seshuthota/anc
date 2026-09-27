export const DEMO_CLOCK = process.env.DEMO_CLOCK ?? "2026-09-20T08:00:00.000Z";

export const CURRENT = { from: "2026-09-19T09:00:00.000Z", to: DEMO_CLOCK };
export const BASELINE = { from: "2026-09-18T09:00:00.000Z", to: "2026-09-19T09:00:00.000Z" };
export const RELEASE_WINDOW = { from: "2026-09-19T00:00:00.000Z", to: DEMO_CLOCK };

export const DEFAULT_THREAD_ID = "local-demo";
