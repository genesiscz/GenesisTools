import type { Area, GenesisToolsAreas } from "@genesiscz/utils/genesis-tools/actions/registry";
import { app } from "./app";
import { permissions } from "./permissions";
import { person } from "./person";
import { terminal } from "./terminal";
import { windows } from "./windows";
import { work } from "./work";

/** Every area, the one list. A new area is its file plus one entry here. */
export const AREAS = { app, windows, person, terminal, permissions, work } satisfies Record<
    keyof GenesisToolsAreas,
    Area
>;
