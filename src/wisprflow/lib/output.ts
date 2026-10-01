import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { renderUnifiedDiff } from "@genesiscz/utils/diff";
import { splitFrontmatter } from "@genesiscz/utils/json2md/frontmatter";
import { logger } from "@genesiscz/utils/logger";

const { log } = logger.scoped("wisprflow-output");

export type WriteStatus = "created" | "unchanged" | "differs" | "replaced";

export interface WriteResult {
    status: WriteStatus;
    path: string;
    /** The unified diff against the file on disk, when it differs. */
    diff?: string;
}

/** A YAML frontmatter split into its top-level keys, each with the lines under it. */
function yamlBlocks(raw: string): Map<string, string[]> {
    const blocks = new Map<string, string[]>();
    let current: string[] | undefined;

    for (const line of raw.split("\n")) {
        const key = line.match(/^([\w-]+):/)?.[1];

        if (key) {
            current = [line];
            blocks.set(key, current);
        } else if (current) {
            current.push(line);
        }
    }

    return blocks;
}

/**
 * Keeps a hand-written frontmatter: every key already in the file stays as it is, and only keys the
 * file lacks are added from the generated one. The body is always the generated one.
 */
export function mergeFrontmatter(existing: string, generated: string): string {
    const old = splitFrontmatter(existing);
    const next = splitFrontmatter(generated);

    if (old.format !== "yaml" || next.format !== "yaml" || old.raw === null || next.raw === null) {
        return generated;
    }

    const kept = yamlBlocks(old.raw);
    const added = [...yamlBlocks(next.raw).entries()].filter(([key]) => !kept.has(key)).flatMap(([, lines]) => lines);
    const merged = [old.raw.trimEnd(), ...added].join("\n");

    // splitFrontmatter eats the blank lines after the closing fence, so put one back.
    return `---\n${merged}\n---\n\n${next.body.replace(/^\n+/, "")}`;
}

/**
 * Writes `content` to `path` unless that would silently replace something different. A new file is
 * written; an identical one is left alone; a different one is only replaced with `confirm`,
 * otherwise the diff comes back for the caller to show.
 */
export function writeGuarded(options: {
    path: string;
    content: string;
    confirm: boolean;
    keepFrontmatter: boolean;
}): WriteResult {
    const { path, confirm } = options;

    if (!existsSync(path)) {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, options.content);
        log.debug({ path }, "created output file");
        return { status: "created", path };
    }

    const before = readFileSync(path, "utf8");
    const after = options.keepFrontmatter ? mergeFrontmatter(before, options.content) : options.content;

    if (before === after) {
        return { status: "unchanged", path };
    }

    if (!confirm) {
        return { status: "differs", path, diff: renderUnifiedDiff({ before, after, label: path.replace(/^\//, "") }) };
    }

    writeFileSync(path, after);
    log.debug({ path }, "replaced output file");
    return { status: "replaced", path };
}
