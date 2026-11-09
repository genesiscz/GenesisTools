import { existsSync, readFileSync } from "node:fs";
import { redact } from "@app/secrets/lib/redact/redact";
import { DEFAULT_TYPES, type RedactType } from "@app/secrets/lib/redact/types";
import { logger } from "@genesiscz/utils/logger";
import { genesisToolsDir } from "@genesiscz/utils/storage/root";

/** One entry of the local personal-data list: a label that names it in reports, and a case-insensitive pattern. */
export interface PersonalMarker {
    label: string;
    pattern: string;
}

/** How many values of each kind a redaction replaced. Values themselves are never reported. */
export type RedactionCounts = Record<RedactType | "markers", number>;

export interface IssueRedaction {
    text: string;
    counts: RedactionCounts;
    /** Labels of markers whose pattern JavaScript cannot compile (the list is PCRE). */
    skipped: string[];
}

/**
 * The personal-data list the pre-push probe uses (`~/.genesis-tools/placeholder-check/markers.txt`, local only, never
 * in the repository): `label<TAB>pattern` per line, `#` comments and blank lines ignored, a line without a tab is its
 * own label. Empty when the file is missing.
 */
export function loadPersonalMarkers(
    file: string = genesisToolsDir("placeholder-check", "markers.txt")
): PersonalMarker[] {
    if (!existsSync(file)) {
        logger.debug({ file }, "issue-redact: no personal-data list, only secrets are redacted");
        return [];
    }

    const markers: PersonalMarker[] = [];
    for (const raw of readFileSync(file, "utf8").split("\n")) {
        const line = raw.trimEnd();
        if (line.trim() === "" || line.trimStart().startsWith("#")) {
            continue;
        }

        const tab = line.indexOf("\t");
        markers.push(
            tab === -1 ? { label: line, pattern: line } : { label: line.slice(0, tab), pattern: line.slice(tab + 1) }
        );
    }

    logger.debug({ file, count: markers.length }, "issue-redact: personal-data list read");
    return markers;
}

export function emptyCounts(): RedactionCounts {
    return { keys: 0, tokens: 0, emails: 0, ips: 0, paths: 0, phones: 0, markers: 0 };
}

/**
 * Replaces the personal-data markers (`[PRIVATE_n]`), then the secrets redactor's kinds (keys, tokens, emails, IP
 * addresses, the home folder) in `text`, adding what it replaced to `counts`.
 */
export function redactIssueText(
    text: string,
    options: { markers: PersonalMarker[]; homeDir: string; counts: RedactionCounts; skipped: Set<string> }
): string {
    let result = text;
    let next = Object.values(options.counts).reduce((sum, n) => sum + n, 0);

    for (const marker of options.markers) {
        let re: RegExp;
        try {
            re = new RegExp(marker.pattern, "gi");
        } catch (error) {
            logger.debug(
                { error, label: marker.label },
                "issue-redact: a marker pattern does not compile in JavaScript"
            );
            options.skipped.add(marker.label);
            continue;
        }

        result = result.replace(re, () => {
            options.counts.markers += 1;
            next += 1;
            return `[PRIVATE_${next}]`;
        });
    }

    const redacted = redact(result, { homeDir: options.homeDir, types: DEFAULT_TYPES });
    for (const token of Object.keys(redacted.mapping)) {
        const kind = kindOfToken(token);
        if (kind) {
            options.counts[kind] += countOf(redacted.redacted, token);
        }
    }

    return redacted.redacted;
}

function kindOfToken(token: string): RedactType | null {
    if (token.startsWith("[HOME")) {
        return "paths";
    }

    const table: [string, RedactType][] = [
        ["[REDACTED_KEY_", "keys"],
        ["[REDACTED_TOKEN_", "tokens"],
        ["[EMAIL_", "emails"],
        ["[IP_", "ips"],
        ["[PHONE_", "phones"],
    ];
    return table.find(([prefix]) => token.startsWith(prefix))?.[1] ?? null;
}

function countOf(text: string, token: string): number {
    return text.split(token).length - 1;
}
