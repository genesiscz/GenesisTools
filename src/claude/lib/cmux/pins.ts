import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { SessionPin } from "@app/claude/lib/cmux/types";
import type { AccountProviderAlias } from "@genesiscz/utils/ai/providers/alias-list";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { Storage } from "@genesiscz/utils/storage/storage";

/**
 * Append-only journal of `session id → account`. Append-only because the writer is a
 * SessionStart hook running inside every claude launch on the machine: concurrent
 * launches must never interleave into a corrupt document, and an O_APPEND write of a
 * single short line is atomic on macOS. Later lines win on read.
 */
export function pinsPath(): string {
    return join(new Storage("claude-code").getBaseDir(), "session-pins.jsonl");
}

/** Lines kept before the journal is compacted to one record per session. */
const COMPACT_THRESHOLD = 4000;

export async function recordPin(pin: SessionPin): Promise<void> {
    const path = pinsPath();
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, `${SafeJSON.stringify(pin)}\n`, "utf8");
}

export interface LoadPinsOptions {
    /**
     * Skip compaction. Reading the journal normally rewrites it once it passes
     * COMPACT_THRESHOLD, which makes an otherwise read-only caller (`--dry-run`)
     * mutate durable state. Those callers pass this.
     */
    readOnly?: boolean;
    /**
     * Keep only this agent's records. Codex and Grok run the same SessionStart hook, so one
     * journal holds all three.
     *
     * 🛑 A record with NO `provider` counts as claude and nothing else. Those lines predate the
     * field, and 9 of them are Codex sessions that captured a Claude account by inheriting
     * `TOOLS_CLAUDE_ACCOUNT` from the pane that launched them. Matching them as codex would
     * publish that mistake as a fact.
     */
    provider?: AccountProviderAlias;
}

/** Every pin, newest write per session id. Missing or torn lines are skipped, never fatal. */
export async function loadPins(opts: LoadPinsOptions = {}): Promise<Map<string, SessionPin>> {
    const path = pinsPath();
    let text: string;

    try {
        text = await readFile(path, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            logger.warn({ err, path }, "[cmux-pins] could not read the pin journal");
        }

        return new Map();
    }

    const pins = new Map<string, SessionPin>();
    let lines = 0;

    for (const line of text.split("\n")) {
        if (!line.trim()) {
            continue;
        }

        lines += 1;

        try {
            const pin = SafeJSON.parse(line, { strict: true }) as SessionPin;

            if (typeof pin.sessionId !== "string") {
                continue;
            }

            if (opts.provider && (pin.provider ?? "claude") !== opts.provider) {
                continue;
            }

            const existing = pins.get(pin.sessionId);

            if (!existing || pin.at >= existing.at) {
                pins.set(pin.sessionId, pin);
            }
        } catch (err) {
            logger.debug({ err }, "[cmux-pins] skipping an unparseable journal line");
        }
    }

    // 🛑 Never compact a FILTERED read. `compact` rewrites the journal as exactly the map it is
    // handed, so compacting after a `provider: "codex"` load would delete every Claude and Grok
    // record in the file.
    if (!opts.readOnly && !opts.provider && lines > COMPACT_THRESHOLD) {
        await compact(path, pins).catch((err) => {
            logger.warn({ err, path }, "[cmux-pins] compaction failed; the journal keeps growing");
        });
    }

    return pins;
}

/**
 * Rewrite the journal as one line per session. Racing a hook append can only lose the
 * pin of a session that started in the same instant, and that session re-pins on its
 * next SessionStart, so no lock is worth the startup cost this pays in every launch.
 */
async function compact(path: string, pins: Map<string, SessionPin>): Promise<void> {
    const body = [...pins.values()]
        .sort((a, b) => a.at - b.at)
        .map((pin) => SafeJSON.stringify(pin))
        .join("\n");
    await writeFile(path, `${body}\n`, "utf8");
    logger.debug({ path, records: pins.size }, "[cmux-pins] compacted the pin journal");
}
