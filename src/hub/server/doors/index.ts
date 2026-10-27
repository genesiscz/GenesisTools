import { agentsCountsDoor, agentsMailDoor, agentsTreeDoor, subagentsDoor } from "./agents";
import { agentsToolChangesDoor } from "./changes";
import {
    forecastDoor,
    inboxDoor,
    procsDoor,
    proposalListDoor,
    repoDoor,
    stuckDoor,
    usageSessionsDoor,
} from "./frequent";
import { navConfigureDoor, navListDoor, navRecordDoor } from "./nav";
import { transcriptFetchDoor, transcriptLiveDoor } from "./transcript";
import type { Door } from "./types";
import { widgetCallDoor, widgetContextDoor, widgetTasksListDoor } from "./widget";

/**
 * Every door the resident server answers. Each one calls the same lib function as its CLI command.
 * Never add a door that is TCC-gated, interactive, spends a credential, starts a long-lived child, or
 * changes process-wide state (plan: .claude/plans/2026-10-01-ResidentGtServer.md, "Doors"). A door that
 * writes durable state is allowed only when the write is idempotent (keyed or set, never appended): a
 * dropped connection sends the same argv to the process, which must then write the same thing again
 * (`hub nav record`, `hub nav configure`, the state actions of `hub widget call`).
 */
export const HUB_SERVER_DOORS: readonly Door[] = [
    transcriptFetchDoor,
    transcriptLiveDoor,
    agentsCountsDoor,
    agentsMailDoor,
    agentsTreeDoor,
    subagentsDoor,
    agentsToolChangesDoor,
    forecastDoor,
    procsDoor,
    stuckDoor,
    inboxDoor,
    repoDoor,
    usageSessionsDoor,
    navListDoor,
    navRecordDoor,
    navConfigureDoor,
    widgetCallDoor,
    widgetContextDoor,
    widgetTasksListDoor,
    proposalListDoor,
];
