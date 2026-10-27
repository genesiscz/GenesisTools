import { asResult } from "@genesiscz/utils/cli/result";
import { logger } from "@genesiscz/utils/logger";
import { navEntryFromFlags, storeNavEntry } from "../../lib/nav-record";
import type { NavEntry } from "../../lib/navigation/types";
import { parseArgv, stringFlag, wholeNumber } from "../argv";
import { type CallDoor, failed, ok } from "./types";

const { log } = logger.scoped("hub:server");

/** A `--keep`/`--limit` the CLI's `positiveInt` takes: a whole number above 0. */
function positive(value: string | true | undefined): number | null {
    const parsed = wholeNumber(value);
    return parsed !== null && parsed > 0 ? parsed : null;
}

/** `hub nav list --json [--limit N]`: the hub's History list. */
export const navListDoor: CallDoor<{ limit?: number }> = {
    kind: "call",
    name: "hub nav list --json",
    command: ["hub", "nav", "list"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "nav", "list"],
            positionals: 0,
            flags: { "--json": "bool", "--limit": "value" },
        });
        if (parsed?.flags.get("--json") !== true) {
            return null;
        }

        if (!parsed.flags.has("--limit")) {
            return {};
        }

        const limit = positive(parsed.flags.get("--limit"));
        return limit === null ? null : { limit };
    },
    async run({ limit }, { signal }) {
        try {
            signal.throwIfAborted();
            const { readNav } = await import("../../lib/navigation/store");
            const { hubDbPath } = await import("../../lib/data-db");
            const { entries, keep } = readNav({ limit });
            return ok(asResult({ entries, keep, path: hubDbPath() }));
        } catch (error) {
            return failed(error);
        }
    },
};

interface NavRecordArgs {
    entry: NavEntry;
    keep?: number;
    replacing?: string[];
    json: boolean;
}

/**
 * `hub nav record --id=… --actor=… --title=… --target=<json> [--at=…] [--note=…] [--from=…] [--keep=N] [--json]
 * [--replacing <id…>]`: every place the hub shows (one process each, about 0.36 s of CPU, before this door). A
 * durable write, and safe as a door: the entry is keyed by its id, so a retry by the process after a dropped
 * connection writes the same row again. `--replacing` is variadic, so the door takes it only last, as the hub
 * sends it; an actor the CLI refuses stays a process, which prints the CLI's error.
 */
export const navRecordDoor: CallDoor<NavRecordArgs> = {
    kind: "call",
    name: "hub nav record",
    command: ["hub", "nav", "record"],
    match(argv) {
        const split = argv.indexOf("--replacing");
        const head = split < 0 ? argv : argv.slice(0, split);
        const replacing = split < 0 ? undefined : argv.slice(split + 1);
        if (replacing && (replacing.length === 0 || replacing.some((id) => id.startsWith("-")))) {
            return null;
        }

        const parsed = parseArgv(head, {
            command: ["hub", "nav", "record"],
            positionals: 0,
            flags: {
                "--id": "value",
                "--actor": "value",
                "--title": "value",
                "--target": "value",
                "--at": "value",
                "--note": "value",
                "--from": "value",
                "--keep": "value",
                "--json": "bool",
            },
        });
        if (!parsed) {
            return null;
        }

        const id = stringFlag(parsed, "--id");
        const actor = stringFlag(parsed, "--actor");
        const title = stringFlag(parsed, "--title");
        const target = stringFlag(parsed, "--target");
        if (id === undefined || actor === undefined || title === undefined || target === undefined) {
            return null;
        }

        const keep = parsed.flags.has("--keep") ? positive(parsed.flags.get("--keep")) : undefined;
        if (keep === null) {
            return null;
        }

        try {
            const entry = navEntryFromFlags({
                id,
                actor,
                title,
                target,
                at: stringFlag(parsed, "--at"),
                note: stringFlag(parsed, "--note"),
                from: stringFlag(parsed, "--from"),
            });
            return entry ? { entry, keep, replacing, json: parsed.flags.get("--json") === true } : null;
        } catch (error) {
            // A target that is not JSON: the process prints the CLI's own error.
            log.debug({ error }, "hub server: hub nav record target unreadable; the process answers");
            return null;
        }
    },
    async run({ entry, keep, replacing, json }, { signal }) {
        try {
            signal.throwIfAborted();
            const stored = storeNavEntry(entry, { keep, replacing });
            return ok(json ? asResult(stored) : "");
        } catch (error) {
            return failed(error);
        }
    },
};

/** `hub nav configure --keep=N`: the History limit, stored, and the log pruned to it. */
export const navConfigureDoor: CallDoor<number> = {
    kind: "call",
    name: "hub nav configure",
    command: ["hub", "nav", "configure"],
    match(argv) {
        const parsed = parseArgv(argv, {
            command: ["hub", "nav", "configure"],
            positionals: 0,
            flags: { "--keep": "value" },
        });
        return parsed ? positive(parsed.flags.get("--keep")) : null;
    },
    async run(keep, { signal }) {
        try {
            signal.throwIfAborted();
            const { openHubDb } = await import("../../lib/data-db");
            const { setNavKeep } = await import("../../lib/navigation/store");
            const db = openHubDb();
            try {
                setNavKeep(db, keep);
            } finally {
                db.close();
            }

            return ok("");
        } catch (error) {
            return failed(error);
        }
    },
};
