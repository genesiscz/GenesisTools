import { isClaude, resolveClaudeContext } from "@genesiscz/utils/agent/hosts/claude";
import { claudeTurnState } from "@genesiscz/utils/agent-sessions/readers/claude-turn-state";
import { deferredLocator, deferredWindowTurns } from "@genesiscz/utils/harness/deferred";
import { interpreterScriptIndex } from "@genesiscz/utils/harness/interpreter-entry";
import type { HarnessDriver } from "@genesiscz/utils/harness/types";
import { claudeDialog } from "./harness-dialog";
import { claudeHooks } from "./harness-hooks";
import { claudeLaunch } from "./harness-launch";

import { claudeWorker } from "./harness-worker";

function claudeScriptIndex(command: string): number | null {
    return interpreterScriptIndex(command, (arg) =>
        /(?:^|[/\\])@anthropic-ai[/\\]claude-code[/\\]cli\.m?js$/.test(arg)
    );
}

/**
 * The Claude Code driver: what GenesisTools knows about the harness, part by part, each one the code its callers
 * read. Light on purpose: identity is data and each part is a lazy import, so reading the driver never loads a parser.
 */
export const claudeHarness: HarnessDriver<"claude"> = {
    id: "claude",
    identity: {
        label: "Claude Code",
        binary: "claude",
        plugin: "anthropic-sub",
        aliases: ["claude-code", "claude_code", "cc"],
        vendor: "anthropic",
        mark: {
            letter: "C",
            color: { red: 0.85, green: 0.47, blue: 0.34 },
            logo: "M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z",
        },
    },
    parts: {
        locate: deferredLocator(import.meta, "harness-locate", "claudeLocate"),
        parse: () => import("./harness-parse").then((m) => m.claudeParse),
        turnState: { read: claudeTurnState },
        launch: claudeLaunch,
        transcript: {
            recordsTerminalEvent: false,
            pagesByTurnIndex: true,
            subagentsOnDisk: true,
            timestampResolutionMs: 0,
            turnIdsEndWithRowUuid: true,
            keepsLiveRegistry: true,
            // Claude records no permission prompt in its transcript; only its `Notification` hook sees one.
            windowTurns: deferredWindowTurns(import.meta, "harness-parse", "claudeWindowTurns"),
        },
        exit: { command: "/exit" },
        hooks: claudeHooks,
        host: {
            agent: "claude-code",
            sessionEnvKey: "CLAUDE_CODE_SESSION_ID",
            detects: isClaude,
            resolve: resolveClaudeContext,
        },
        process: {
            runsCli: ({ argv0, name, command }) =>
                name === "claude" ||
                /\/claude\/versions\/[\d.]+$/.test(argv0) ||
                ((name === "node" || name === "bun") && claudeScriptIndex(command) !== null),
            cliEntryIndex: ({ argv0, name, command }) =>
                name === "claude" || /\/claude\/versions\/[\d.]+$/.test(argv0)
                    ? 0
                    : name === "node" || name === "bun"
                      ? claudeScriptIndex(command)
                      : null,
        },
        worker: claudeWorker,
        dialog: claudeDialog,
    },
};
