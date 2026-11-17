import { sessionHostActJson, sessionHostDescribeJson } from "@app/ai/lib/session-host/output";
import { asResult } from "@genesiscz/utils/cli/result";
import { parseArgv } from "../argv";
import { type CallDoor, failed, ok } from "./types";

const COMMAND = ["ai", "session-host"] as const;

/** `ai session-host describe <ids…> --json`: where each session lives, for the Genesis session window. */
export const sessionHostDescribeDoor: CallDoor<string[]> = {
    kind: "call",
    name: "ai session-host describe --json",
    command: [...COMMAND, "describe"],
    match(argv) {
        const ids = argv.slice(3).filter((word) => !word.startsWith("-"));
        const parsed = parseArgv(argv, {
            command: [...COMMAND, "describe"],
            positionals: ids.length,
            flags: { "--json": "bool" },
        });
        return parsed?.flags.get("--json") === true && parsed.positionals.length > 0 ? parsed.positionals : null;
    },
    async run(sessionIds, { signal }) {
        try {
            signal.throwIfAborted();
            return ok(asResult(await sessionHostDescribeJson(sessionIds)));
        } catch (error) {
            return failed(error);
        }
    },
};

/**
 * `ai session-host focus <id> --json`: raise the session where it lives (its cmux pane, its T3 Code thread). A refusal
 * prints its JSON and exits 1, as the CLI does. Only Focus has a door: it is idempotent, so the process the client
 * falls back to after a dropped connection raises the same place again. Wake and Keepalive send a message, and a
 * second send is a second turn, so they stay processes (the rule above HUB_SERVER_DOORS).
 */
export const sessionHostFocusDoor: CallDoor<string> = {
    kind: "call",
    name: "ai session-host focus --json",
    command: [...COMMAND, "focus"],
    match(argv) {
        const parsed = parseArgv(argv, { command: [...COMMAND, "focus"], positionals: 1, flags: { "--json": "bool" } });
        return parsed?.flags.get("--json") === true ? parsed.positionals[0] : null;
    },
    async run(sessionId, { signal }) {
        try {
            signal.throwIfAborted();
            const { json, ok: done } = await sessionHostActJson({ sessionId, action: "focus" });
            return { stdout: asResult(json), stderr: "", exit: done ? 0 : 1 };
        } catch (error) {
            return failed(error);
        }
    },
};
