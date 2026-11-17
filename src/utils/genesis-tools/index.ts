import { type AreaClients, stitchAreas } from "@genesiscz/utils/genesis-tools/actions/registry";
import { AREAS } from "@genesiscz/utils/genesis-tools/areas";

export type { ActionOutcome, Fix, SkippedWay, UnavailableCode, WayName } from "./actions/define";
export { defineAction, defineArea } from "./actions/define";
export type { AreaClients, GenesisToolsAreas } from "./actions/registry";
export { Need, type NeedSpec } from "./capability/needs";

/** `gt.<area>.<action>(args)`: runs an action through the engine (spec `actions.v1.md`). */
export const gt: AreaClients = stitchAreas(AREAS);
