import { agentsCountsDoor, agentsMailDoor, agentsTreeDoor, subagentsDoor } from "./agents";
import { forecastDoor, inboxDoor, procsDoor, repoDoor, stuckDoor, usageSessionsDoor } from "./frequent";
import { transcriptFetchDoor, transcriptLiveDoor } from "./transcript";
import type { Door } from "./types";

/**
 * Every door the resident server answers. Each one calls the same lib function as its CLI command.
 * Never add a door that is TCC-gated, interactive, writes durable state, spends a credential, or
 * changes process-wide state (plan: .claude/plans/2026-10-01-ResidentGtServer.md, "Doors").
 */
export const HUB_SERVER_DOORS: readonly Door[] = [
    transcriptFetchDoor,
    transcriptLiveDoor,
    agentsCountsDoor,
    agentsMailDoor,
    agentsTreeDoor,
    subagentsDoor,
    forecastDoor,
    procsDoor,
    stuckDoor,
    inboxDoor,
    repoDoor,
    usageSessionsDoor,
];
