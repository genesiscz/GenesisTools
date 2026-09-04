#!/usr/bin/env bun
/**
 * Refresh ~/.genesis-tools/placeholder-check/markers.txt from the local
 * Teams people/conversation cache. Prints COUNTS only. Never prints a name
 * or email. The markers file is outside git on purpose.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { cacheDbPath } from "@app/ms-teams/lib/paths";
import { TeamsCache } from "@app/ms-teams/lib/store";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";

const log = logger.scoped("placeholder-check").log;

export const AUTO_BEGIN = "# --- auto: ms-teams (generated, do not edit) ---";
export const AUTO_END = "# --- end auto: ms-teams ---";

export type PersonLike = { displayName?: string | null; email?: string | null; upn?: string | null };

export function pcreLiteral(value: string): string {
    return `\\Q${value.replaceAll("\\E", "\\E\\\\E\\Q")}\\E`;
}

function hostOf(email: string): string {
    return email.split("@")[1]?.toLowerCase() ?? "";
}

function isServiceHost(host: string): boolean {
    return host === "microsoft.com" || host === "skype.com" || host.endsWith(".microsoft.com");
}

export function isUsableEmail(email: string): boolean {
    const trimmed = email.trim();

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        return false;
    }

    const local = trimmed.split("@")[0] ?? "";
    const host = hostOf(trimmed);

    if (isServiceHost(host)) {
        return false;
    }

    if (local.toLowerCase().startsWith("room_")) {
        return false;
    }

    return true;
}

export function personDisplayName(displayName: string): string | null {
    const trimmed = displayName.trim();

    if (trimmed.length < 5) {
        return null;
    }

    if (trimmed.startsWith("8:orgid:")) {
        return null;
    }

    if (/^[0-9a-f-]{8,}$/i.test(trimmed)) {
        return null;
    }

    if (/\d/.test(trimmed)) {
        return null;
    }

    const words = trimmed.split(/\s+/);

    if (words.length < 2 || words.length > 3) {
        return null;
    }

    if (words.some((word) => word.length < 2)) {
        return null;
    }

    const first = words[0]?.toLowerCase() ?? "";

    if (first === "room" || first === "unknown" || first === "microsoft") {
        return null;
    }

    return trimmed;
}

export function needlesFromPeople(people: PersonLike[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];

    const add = (kind: string, value: string) => {
        const key = value.toLowerCase();

        if (seen.has(key)) {
            return;
        }

        seen.add(key);
        out.push(`${kind}\t${pcreLiteral(value)}`);
    };

    for (const person of people) {
        if (person.email && isUsableEmail(person.email)) {
            add("email", person.email.trim());
        }

        if (person.upn && isUsableEmail(person.upn) && person.upn.trim() !== person.email?.trim()) {
            add("email", person.upn.trim());
        }

        const name = person.displayName ? personDisplayName(person.displayName) : null;

        if (!name) {
            continue;
        }

        add("name", name);
        const parts = name.split(/\s+/);

        if (parts.length === 2 && parts[0] && parts[1]) {
            add("name", `${parts[1]} ${parts[0]}`);
        }
    }

    return out.sort((a, b) => a.localeCompare(b));
}

/** The needles currently inside the auto block, ignoring comments and blanks. */
export function autoBlockLines(existing: string): string[] {
    const begin = existing.indexOf(AUTO_BEGIN);
    const end = existing.indexOf(AUTO_END);

    if (begin < 0 || end <= begin) {
        return [];
    }

    return existing
        .slice(begin + AUTO_BEGIN.length, end)
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith("#"));
}

export function spliceAutoBlock(existing: string, autoLines: string[]): string {
    const begin = existing.indexOf(AUTO_BEGIN);
    const end = existing.indexOf(AUTO_END);
    const block = [AUTO_BEGIN, ...autoLines, AUTO_END].join("\n");

    if (begin >= 0 && end > begin) {
        const afterEnd = end + AUTO_END.length;
        const before = existing.slice(0, begin).replace(/\n+$/, "");
        const after = existing.slice(afterEnd).replace(/^\n+/, "");
        return `${[before, block, after].filter((part) => part.length > 0).join("\n\n")}\n`;
    }

    const trimmed = existing.replace(/\n+$/, "");

    if (trimmed.length === 0) {
        return `${block}\n`;
    }

    return `${trimmed}\n\n${block}\n`;
}

export function markersPath(home = homedir()): string {
    return join(home, ".genesis-tools/placeholder-check/markers.txt");
}

function peopleFromConversations(cache: TeamsCache): PersonLike[] {
    const extra: PersonLike[] = [];

    for (const row of cache.listConversations({ limit: 10_000 })) {
        let members: PersonLike[] = [];

        try {
            const parsed = SafeJSON.parse(row.membersJson);

            if (Array.isArray(parsed)) {
                members = parsed.filter((item) => item !== null && typeof item === "object") as PersonLike[];
            }
        } catch (err) {
            log.debug({ err, conversationId: row.id }, "[placeholder-check] skip membersJson");
            continue;
        }

        extra.push(...members);
    }

    return extra;
}

export interface HarvestResult {
    /** What this harvest produced, whether or not it was written. */
    emails: number;
    names: number;
    lines: number;
    /** Auto-block lines already in the markers file before this run. */
    previous: number;
    /** True when the existing block was kept because this harvest looked degraded. */
    refused: boolean;
}

/**
 * A harvest smaller than this share of the previous one is refused.
 *
 * The guard used to fire only on a TOTALLY empty harvest, which is the rarest
 * degradation. A Teams cache that survived a repair with 5 of 400 people, or a
 * `membersJson` schema change that makes most rows fail their parse, produced a
 * few needles, passed, and overwrote the block. The pre-push hook then scanned
 * that very push against 5 needles and reported a clean run against the 395 it
 * had just deleted.
 */
export const HARVEST_FLOOR_RATIO = 0.5;

/** True when this harvest is too much smaller than the block it would replace. */
export function harvestLooksDegraded(harvested: number, previous: number): boolean {
    if (previous === 0) {
        return false;
    }

    return harvested < previous * HARVEST_FLOOR_RATIO;
}

export function harvestToFile(opts: { cachePath: string; markersFile: string }): HarvestResult {
    const cache = new TeamsCache(opts.cachePath, { readonly: true });

    try {
        const people = [...cache.listPeople(), ...peopleFromConversations(cache)];
        const autoLines = needlesFromPeople(people);
        const existing = existsSync(opts.markersFile) ? readFileSync(opts.markersFile, "utf8") : "";
        const previous = autoBlockLines(existing);
        // Always the real harvest, refusal included. Reporting zeroes on a
        // refusal read as "the Teams cache is empty" when the truth may be
        // "the cache halved", and those two need different fixes.
        const counts = {
            emails: autoLines.filter((line) => line.startsWith("email\t")).length,
            names: autoLines.filter((line) => line.startsWith("name\t")).length,
            lines: autoLines.length,
            previous: previous.length,
        };

        // A degraded cache (a Teams repair, an empty or half-parsed IndexedDB
        // dump) yields far fewer people than the last run. Writing that would
        // gut the block on the very push it gates: pre-push harvests first and
        // then runs placeholder-check, which would report a clean scan against
        // needles that had just been deleted.
        if (harvestLooksDegraded(autoLines.length, previous.length)) {
            log.warn(
                { markersFile: opts.markersFile, harvested: autoLines.length, previous: previous.length },
                "[placeholder-check] harvest shrank sharply — keeping the existing auto block"
            );

            return { ...counts, refused: true };
        }

        mkdirSync(dirname(opts.markersFile), { recursive: true, mode: 0o700 });
        writeFileSync(opts.markersFile, spliceAutoBlock(existing, autoLines), { encoding: "utf8", mode: 0o600 });

        return { ...counts, refused: false };
    } finally {
        cache.close();
    }
}

if (import.meta.main) {
    const cachePath = cacheDbPath();

    if (!existsSync(cachePath)) {
        // The pre-push hook runs this on every clone. Without a Teams cache
        // there is nothing to harvest, and that must not block a push.
        console.log("placeholder markers: no Teams cache on this machine, nothing harvested.");
        process.exit(0);
    }

    const dest = env.get("PLACEHOLDER_MARKERS_FILE") ?? markersPath();
    const stats = harvestToFile({ cachePath, markersFile: dest });

    if (stats.refused) {
        console.log(
            `placeholder markers: harvested ${stats.lines} needles (${stats.emails} email, ${stats.names} name) ` +
                `against ${stats.previous} from the previous run — too few, so the ${stats.previous} already in ${dest} were kept`
        );
    } else {
        console.log(
            `placeholder markers: ${stats.lines} auto needles (${stats.emails} email, ${stats.names} name) -> ${dest}`
        );
    }

    console.log("counts only; the file is outside git.");
}
