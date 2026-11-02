import type { ClarityAuthDriver } from "@app/clarity/lib/auth/types";

/** Drivers a downstream copy of this tool adds after the built-in cURL driver. */
export const extraAuthDrivers: ClarityAuthDriver[] = [];
