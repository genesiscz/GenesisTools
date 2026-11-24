import { existsSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { toolCommand } from "@genesiscz/utils/cli/tool-command";
import { SafeJSON } from "@genesiscz/utils/json";
import {
    MEETINGS_POLISHED_SPECIFIER,
    type MeetingsPolishedInput,
    meetingsPolishedSchema,
} from "@genesiscz/utils/meetings/polished";
import { MEETING_SOURCE_IDS } from "@genesiscz/utils/meetings/sources";
import { z } from "zod";
import { unlinkedPolishedDir } from "./build";

/** What adopting a draft did with each of its fields. */
export interface AdoptReport {
    /** Draft fields that became config fields: `glossaryMd → glossary.md`. */
    mapped: string[];
    /** Draft fields the build does not read, kept under `extras` so nothing is lost. */
    kept: string[];
    /** Choices an agent should check. */
    notes: string[];
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
    return typeof value === "string" ? value : undefined;
}

/** The keys each list entry of the config accepts; any other key of a draft entry moves to `extras`. */
const ENTRY_KEYS: Record<string, readonly string[]> = {
    updates: ["at", "text"],
    transcriptMarks: ["record", "text", "note"],
    participants: ["person", "role", "seat", "present"],
    labelMap: ["record", "rawLabel", "person", "range", "evidence"],
    sections: ["heading", "after", "intro", "md"],
    unresolved: ["id", "record", "at", "heard", "sentence", "question", "readings", "elseReading", "screen", "listen"],
};

/** Draft fields that are known and superseded: kept in `extras`, never read. */
const SUPERSEDED: Record<string, string> = {
    $schema: "the draft's schema note",
    timeTokens: "the token map is parts[].token now",
    termFixes: "the build reads the term items from the records",
    liveFromRecords: "the build reads these from the records",
};

const SOURCE_IDS: ReadonlySet<string> = new Set(MEETING_SOURCE_IDS);
const PART_KEYS = new Set(["part", "record", "token", "start", "end", "rawExport", "shareLink"]);
const BARE_TIME = /(?<![\w:.[])\d{1,2}:\d{2}(?::\d{2})?(?![\w:\]])/;

function entries(field: string, value: unknown, extras: Json, report: AdoptReport): Json[] {
    if (!Array.isArray(value)) {
        extras[field] = value;
        report.kept.push(`${field} (not a list)`);
        return [];
    }

    const known = ENTRY_KEYS[field] ?? [];
    return value.map((entry, index) => {
        if (!isObject(entry)) {
            extras[`${field}[${index}]`] = entry;
            report.kept.push(`${field}[${index}] (not an object)`);
            return {};
        }

        const kept: Json = {};

        for (const [key, inner] of Object.entries(entry)) {
            if (known.includes(key)) {
                kept[key] = inner;
                continue;
            }

            extras[`${field}[${index}].${key}`] = inner;
            report.kept.push(`${field}[${index}].${key}`);
        }

        return kept;
    });
}

function adoptParts(value: unknown, extras: Json, report: AdoptReport): Json[] {
    if (!Array.isArray(value)) {
        throw new Error("The draft has no parts list: a polished file needs at least one part with its record.");
    }

    const parts = value.filter(isObject);
    const ordered = [...parts].sort((a, b) => Number(a.part ?? 0) - Number(b.part ?? 0));

    return ordered.map((part, index) => {
        const sources: Record<string, Json> = {};
        const adopted: Json = {
            record: part.record,
            token: part.token ?? (ordered.length === 1 ? "t" : undefined),
        };

        for (const key of ["start", "end", "rawExport"] as const) {
            if (part[key] !== undefined) {
                adopted[key] = part[key];
            }
        }

        for (const [key, inner] of Object.entries(part)) {
            if (PART_KEYS.has(key)) {
                continue;
            }

            if (SOURCE_IDS.has(key)) {
                sources[key] = { ...(sources[key] ?? {}), meetingId: inner };
                report.mapped.push(`parts[${index}].${key} → parts[${index}].sources.${key}.meetingId`);
                continue;
            }

            extras[`parts[${index}].${key}`] = inner;
            report.kept.push(`parts[${index}].${key}`);
        }

        if (part.shareLink !== undefined) {
            const owner = Object.keys(sources)[0];

            if (owner) {
                sources[owner] = { ...sources[owner], shareLink: part.shareLink };
                report.mapped.push(`parts[${index}].shareLink → parts[${index}].sources.${owner}.shareLink`);
            } else {
                extras[`parts[${index}].shareLink`] = part.shareLink;
                report.kept.push(`parts[${index}].shareLink (no source id beside it)`);
            }
        }

        if (Object.keys(sources).length > 0) {
            adopted.sources = sources;
        }

        return adopted;
    });
}

/**
 * Turns a draft `<name>.polished.json` (the hand-built data of a polished file) into a polished config. Every draft
 * field lands somewhere: a config field, or `extras` (kept, never rendered) with a line in the report.
 */
export function adoptPolishedDraft(draft: unknown): { config: MeetingsPolishedInput; report: AdoptReport } {
    if (!isObject(draft)) {
        throw new Error("The draft is not a JSON object.");
    }

    const report: AdoptReport = { mapped: [], kept: [], notes: [] };
    const extras: Json = {};
    const config: Json = {};
    const frontmatter: Json = {};
    const sections: Record<string, string> = {
        glossaryMd: "glossary",
        referencesMd: "references",
        summaryMd: "summary",
        summaryDiffMd: "summaryDiff",
    };
    const direct = new Set([
        "title",
        "private",
        "status",
        "writtenAt",
        "updatedAt",
        "namedNotPresent",
        "heading",
        "intro",
    ]);

    for (const [key, value] of Object.entries(draft)) {
        if (key === "parts") {
            config.parts = adoptParts(value, extras, report);
            report.mapped.push("parts");
        } else if (direct.has(key)) {
            config[key] = value;
            report.mapped.push(key);
        } else if (key in ENTRY_KEYS) {
            config[key] = entries(key, value, extras, report);
            report.mapped.push(key);
        } else if (key in sections && typeof value === "string") {
            config[sections[key]!] = { md: value };
            report.mapped.push(`${key} → ${sections[key]}.md`);
        } else if (key === "ado") {
            frontmatter.ado = value;
            report.mapped.push("ado → frontmatter.ado");
        } else {
            extras[key] = value;
            report.kept.push(key in SUPERSEDED ? `${key} (${SUPERSEDED[key]})` : `${key} (unknown field)`);
        }
    }

    if (Object.keys(frontmatter).length > 0) {
        config.frontmatter = frontmatter;
    }

    const references = isObject(config.references) ? text(config.references.md) : undefined;
    const parts = Array.isArray(config.parts) ? config.parts.filter(isObject) : [];
    const lastToken = text(parts.at(-1)?.token);

    if (
        references &&
        lastToken &&
        !references.includes("[[") &&
        references.split("\n").some((line) => line.startsWith("- ") && BARE_TIME.test(line))
    ) {
        config.references = { md: references, linkBareTimes: lastToken };
        report.notes.push(
            `references: bare times on bullet lines link to part "${lastToken}" (the last part); a time after a part's marker links to that part. Set parts[].marker, or change references.linkBareTimes.`
        );
    }

    if (parts.length > 1 && parts.some((part) => part.marker === undefined)) {
        report.notes.push(
            "parts[].marker is unset: inside diff blocks a time of another part prints without the words that name its recording."
        );
    }

    if (Object.keys(extras).length > 0) {
        config.extras = extras;
    }

    if (typeof config.title !== "string") {
        throw new Error("The draft has no title.");
    }

    const parsed = meetingsPolishedSchema.safeParse(config);

    if (!parsed.success) {
        throw new Error(`The adopted config is not valid:\n${z.prettifyError(parsed.error)}`);
    }

    // The parsed form, defaults filled in, so the agent sees every setting the build uses (transcript.applyAbove).
    return { config: parsed.data, report };
}

/** The `.polished.ts` an agent edits: one import and one `defineMeetingsPolished` call holding the whole config. */
export function polishedModuleSource(config: MeetingsPolishedInput, file: string): string {
    const name = basename(file);
    return [
        `import { defineMeetingsPolished } from "${MEETINGS_POLISHED_SPECIFIER}";`,
        "",
        "/**",
        " * The authored part of this meeting's polished file. Edit this file, never the .md beside it:",
        ` *   build:  ${toolCommand("meetings polish build", name)}`,
        ` *   check:  ${toolCommand("meetings polish build", name, "--check")}`,
        " * [[<token>:MM:SS]] in any text plays that part's record at that time (parts[].token).",
        " */",
        `export default defineMeetingsPolished(${SafeJSON.stringify(config, null, 4)});`,
        "",
    ].join("\n");
}

export interface PolishInitResult {
    path: string;
    report: AdoptReport;
    /** A folder the new module cannot resolve `@genesiscz/utils` from; `tools link install` fixes it. */
    unlinkedDir: string | null;
}

/**
 * `tools meetings polish init --from <draft.json>`: writes a NEW `.polished.ts` from a draft JSON, once. Refuses to
 * overwrite an existing file; writes nothing when the adopted config does not validate.
 */
export async function initPolished(options: { from: string; out?: string }): Promise<PolishInitResult> {
    const from = isAbsolute(options.from) ? options.from : resolve(process.cwd(), options.from);
    const out = options.out
        ? isAbsolute(options.out)
            ? options.out
            : resolve(process.cwd(), options.out)
        : resolve(dirname(from), `${basename(from).replace(/\.json$/, "")}.ts`);

    if (existsSync(out)) {
        throw new Error(`${out} exists already; init never overwrites it. Edit it, or pass --out for a new file.`);
    }

    const draft: unknown = SafeJSON.parse(await Bun.file(from).text());
    const { config, report } = adoptPolishedDraft(draft);
    await Bun.write(out, polishedModuleSource(config, out));

    return { path: out, report, unlinkedDir: await unlinkedPolishedDir(out) };
}
