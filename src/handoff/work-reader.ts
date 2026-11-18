import { handoffQueries } from "@genesiscz/utils/work/legacy/handoff-read";
import { applyGetClaim } from "./executor";
import { HandoffReader } from "./reader";

export const workHandoffReader = new HandoffReader(handoffQueries, applyGetClaim);
