// Constants only: the db-free subpath, so the composer input path never loads better-sqlite3.
import { DEMO_CLOCK as SIMULATION_CLOCK, TIMEZONE, toLocalIso } from "@anc/logistics-db/constants";

/** The network's fixed "now". Every question is answered as of this instant. */
export const DEMO_CLOCK = SIMULATION_CLOCK;
export { TIMEZONE };

const HOUR = 3_600_000;
const now = Date.parse(DEMO_CLOCK);

/** The default period a specialist looks at: the 24 hours up to now. */
export const CURRENT = { from: toLocalIso(now - 24 * HOUR), to: DEMO_CLOCK };

export const DEFAULT_THREAD_ID = "local-demo";
