import type { Area, GenesisToolsAreas } from "@genesiscz/utils/genesis-tools/actions/registry";
import { app } from "./app";
import { windows } from "./windows";

/** Every area, the one list. A new area is its file plus one entry here. */
export const AREAS = { app, windows } satisfies Record<keyof GenesisToolsAreas, Area>;
