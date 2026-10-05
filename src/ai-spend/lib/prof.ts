import { profiler } from "@genesiscz/utils/profile";

/** One scope for the whole tool; `PROFILE=ai-spend tools ai-spend ...` prints where the time went. */
export const prof = profiler.scope("ai-spend");
