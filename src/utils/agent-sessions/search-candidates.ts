import { statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { concurrentMap } from "@genesiscz/utils/async";
import { ripgrepBinary } from "@genesiscz/utils/ripgrep";
import type { AgentSearchFilters, NativeSessionSource } from "./types";

export interface HistoryCandidate {
    source: NativeSessionSource<string>;
    mtime: number;
    matchCount: number;
}

function commonDirectory(paths: string[]): string {
    let directory = dirname(paths[0]);

    for (const path of paths) {
        while (true) {
            const child = relative(directory, path);
            const parent = dirname(directory);

            if (
                (!isAbsolute(child) && child !== ".." && !child.startsWith("../") && !child.startsWith("..\\")) ||
                parent === directory
            ) {
                break;
            }

            directory = parent;
        }
    }

    return directory;
}

function argumentBatches(paths: string[], directory: string): string[][] {
    const batches: string[][] = [];
    let batch: string[] = [];
    let bytes = 0;

    for (const path of paths) {
        const size = Buffer.byteLength(relative(directory, path)) + 1;

        if (batch.length && bytes + size > 96 * 1024) {
            batches.push(batch);
            batch = [];
            bytes = 0;
        }

        batch.push(path);
        bytes += size;
    }

    if (batch.length) {
        batches.push(batch);
    }

    return batches;
}

interface SearchGroup {
    directory: string;
    operands: string[];
    paths: string[];
    recursive: boolean;
}

function searchGroups(sources: NativeSessionSource<string>[], paths: string[]): SearchGroup[] {
    const assigned = new Set<string>();
    const groups: SearchGroup[] = [];

    for (const root of [...new Set(sources.map((source) => resolve(source.root)))]) {
        const members = paths.filter((path) => {
            const child = relative(root, path);
            return !assigned.has(path) && !isAbsolute(child) && child !== ".." && !child.startsWith("../");
        });

        if (members.length === 0) {
            continue;
        }

        members.forEach((path) => {
            assigned.add(path);
        });
        groups.push({ directory: root, operands: ["."], paths: members, recursive: true });
    }

    const remaining = paths.filter((path) => !assigned.has(path));
    if (remaining.length > 0) {
        const directory = commonDirectory(remaining);
        groups.push(
            ...argumentBatches(remaining, directory).map((batch) => ({
                directory,
                operands: batch.map((path) => relative(directory, path)),
                paths: batch,
                recursive: false,
            }))
        );
    }

    return groups;
}

/** The `\uXXXX` form of each distinct character of the needle, in both letter cases. */
function needleEscapes(needle: string | undefined): string[] {
    if (!needle) {
        return [];
    }

    const escapes = new Set<string>();

    for (const character of new Set(needle.toLowerCase())) {
        const point = character.codePointAt(0) ?? 0;

        if (point < 0x80) {
            escapes.add(`\\u${point.toString(16).padStart(4, "0")}`);
            escapes.add(`\\u${point.toString(16).padStart(4, "0").toUpperCase()}`);
        }
    }

    return [...escapes];
}

/** JSON escaping can hide a literal word: sources that escaped it always remain candidates. */
export async function historyCandidates(options: {
    sources: NativeSessionSource<string>[];
    filters: AgentSearchFilters;
}): Promise<HistoryCandidate[]> {
    const { filters } = options;
    const queryWords = filters.regex ? [] : ((filters.query ?? "").match(/[a-z0-9_-]{3,}/gi) ?? []);
    const queryNeedle = queryWords.sort((left, right) => right.length - left.length)[0];
    // A commit search had no needle at all, so every source was parsed: about 42 s for a hash
    // nothing mentions. It is safe to narrow on the hash because the reader only ever records
    // `\b[a-f0-9]{7,40}\b`, and a hit needs one recorded hash to be a prefix of the requested one
    // or the reverse — so any transcript that can match holds these seven characters verbatim.
    // Not when `--commit-msg` is also set: `search-source.ts` short-circuits the hash gate then, so
    // a session that matches only the MESSAGE is a legitimate hit even though it never mentions the
    // hash. Narrowing on the hash would drop it, which is a silent result change, not a speed-up.
    const commitNeedle =
        queryNeedle || filters.commitMessage ? undefined : filters.commitHash?.toLowerCase().slice(0, 7);
    const needle = queryNeedle ?? commitNeedle;
    const counts = new Map<string, number>();
    const checked = new Set<string>();
    const paths = [...new Set(options.sources.flatMap((source) => source.searchPaths ?? []))];
    const binary = needle && paths.length ? ripgrepBinary() : null;
    // A source that escaped the needle still has to stay a candidate, but a bare `\u` catch-all
    // matched every transcript holding any escape (2,041 of 12,111 here) and made an absent-term
    // search cost about 49 s instead of 1.4 s. Any escaped form of the needle, whole or partial,
    // contains the escape of one of its own characters, so ask for exactly those. A commit needle
    // needs none of this: hex is never JSON-escaped, and the escapes would undo its narrowing.
    const escapedNeedles = queryNeedle ? needleEscapes(queryNeedle) : [];
    const counting = Boolean(filters.sortByRelevance);

    if (needle && binary && paths.length) {
        await concurrentMap({
            items: searchGroups(options.sources, paths),
            concurrency: 4,
            async fn(group) {
                filters.signal?.throwIfAborted();

                try {
                    // Roots avoid thousands of per-file arguments. Extra JSONL hits are ignored,
                    // so provider discovery remains the authority for candidate membership.
                    const child = Bun.spawn(
                        [
                            binary,
                            "--no-config",
                            "--no-heading",
                            "--with-filename",
                            "--null",
                            "--color",
                            "never",
                            "--text",
                            "--hidden",
                            "--no-ignore",
                            ...(group.recursive ? ["--glob", "*.jsonl"] : []),
                            counting ? "--count-matches" : "--files-with-matches",
                            "--max-count",
                            counting ? "20" : "1",
                            "--ignore-case",
                            "--fixed-strings",
                            "-e",
                            needle,
                            ...escapedNeedles.flatMap((pattern) => ["-e", pattern]),
                            "--",
                            ...group.operands,
                        ],
                        { cwd: group.directory, stdout: "pipe", stderr: "pipe" }
                    );
                    const abort = () => child.kill();
                    filters.signal?.addEventListener("abort", abort, { once: true });

                    try {
                        const [output, , exitCode] = await Promise.all([
                            new Response(child.stdout).text(),
                            new Response(child.stderr).text(),
                            child.exited,
                        ]);
                        filters.signal?.throwIfAborted();

                        if (exitCode !== 0 && exitCode !== 1) {
                            return;
                        }

                        const batchPaths = new Set(group.paths);
                        const batchCounts = new Map<string, number>();
                        let cursor = 0;
                        let valid = true;

                        if (!counting) {
                            valid = output.length === 0 || output.endsWith("\0");
                            for (const entry of output.split("\0").slice(0, -1)) {
                                const path = resolve(group.directory, entry);
                                if (batchPaths.has(path)) {
                                    batchCounts.set(path, 1);
                                }
                            }
                        } else {
                            while (cursor < output.length) {
                                const separator = output.indexOf("\0", cursor);
                                const end = output.indexOf("\n", separator + 1);

                                if (separator < 0 || end < 0) {
                                    valid = false;
                                    break;
                                }

                                const path = resolve(group.directory, output.slice(cursor, separator));
                                const countText = output.slice(separator + 1, end);

                                if (!/^\d+$/.test(countText)) {
                                    valid = false;
                                    break;
                                }

                                if (batchPaths.has(path)) {
                                    batchCounts.set(path, Number(countText));
                                }
                                cursor = end + 1;
                            }
                        }

                        if (!valid) {
                            return;
                        }

                        for (const path of group.paths) {
                            checked.add(path);
                        }

                        for (const [path, count] of batchCounts) {
                            counts.set(path, count);
                        }
                    } finally {
                        filters.signal?.removeEventListener("abort", abort);
                    }
                } catch {
                    filters.signal?.throwIfAborted();
                    // Failed acceleration leaves this batch eligible for authoritative scanning.
                }
            },
        });
    }

    filters.signal?.throwIfAborted();
    return options.sources.flatMap((source) => {
        const searchable = source.searchPaths;

        if (needle && searchable?.length && searchable.every((path) => checked.has(path) && !counts.has(path))) {
            return [];
        }

        let mtime = source.metadata?.mtime?.getTime() ?? 0;

        try {
            mtime = statSync(source.filePath).mtimeMs;
        } catch {
            // The authoritative reader reports unavailable sources.
        }

        return [{ source, mtime, matchCount: Math.max(0, ...(searchable ?? []).map((path) => counts.get(path) ?? 0)) }];
    });
}

/** Characters kept on each side of the hit; the picker truncates further itself. */
const SNIPPET_CONTEXT = 160;
/** Hits per file ripgrep reports, so a hit inside a uuid or a hash can be passed over for a prose one. */
const SNIPPET_HITS_PER_FILE = 3;

/**
 * A short query such as `7404` also matches inside uuids and content hashes, and a raw JSONL
 * line is full of those. Prefer a window whose hit is not part of a long hex run.
 */
function hitLooksLikeIdentifier(snippet: string, needle: string): boolean {
    const at = snippet.toLowerCase().indexOf(needle.toLowerCase());

    if (at < 0) {
        return false;
    }

    let start = at;
    let end = at + needle.length;

    while (start > 0 && /[0-9a-f-]/i.test(snippet[start - 1] ?? "")) {
        start--;
    }

    while (end < snippet.length && /[0-9a-f-]/i.test(snippet[end] ?? "")) {
        end++;
    }

    return end - start >= 20;
}

/** The raw window comes from a JSONL line: undo the JSON escapes and collapse whitespace. */
function decodeSnippet(raw: string): string {
    return raw
        .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
        .replace(/\\[ntr]/g, " ")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * One ripgrep pass over the candidate files that returns, per file, the text around the first
 * hit: the picker's snippet without parsing a transcript. `searchHistorySource` produced it from
 * the matched record's text, which meant parsing every record of every candidate (and running
 * the commit regexes on each) for a line the picker shows once.
 */
export async function matchSnippets(options: {
    files: string[];
    query: string;
    signal?: AbortSignal;
}): Promise<Map<string, string>> {
    const snippets = new Map<string, string>();
    const needle = (options.query.match(/[a-z0-9_-]{3,}/gi) ?? []).sort((left, right) => right.length - left.length)[0];
    const binary = needle && options.files.length ? ripgrepBinary() : null;

    if (!needle || !binary) {
        return snippets;
    }

    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const child = Bun.spawn(
        [
            binary,
            "--no-config",
            "--no-heading",
            "--with-filename",
            "--null",
            "--color",
            "never",
            "--text",
            "--hidden",
            "--no-ignore",
            "--max-count",
            String(SNIPPET_HITS_PER_FILE),
            "--only-matching",
            "--ignore-case",
            "-e",
            `.{0,${SNIPPET_CONTEXT}}${escaped}.{0,${SNIPPET_CONTEXT}}`,
            "--",
            ...options.files,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    const abort = () => child.kill();
    options.signal?.addEventListener("abort", abort, { once: true });

    try {
        const [output, , exitCode] = await Promise.all([
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
            child.exited,
        ]);

        if (exitCode !== 0 && exitCode !== 1) {
            return snippets;
        }

        const identifierHits = new Set<string>();

        for (const line of output.split("\n")) {
            const separator = line.indexOf("\0");

            if (separator < 0) {
                continue;
            }

            const path = line.slice(0, separator);
            const snippet = decodeSnippet(line.slice(separator + 1));
            const identifier = hitLooksLikeIdentifier(snippet, needle);

            // First prose hit wins; an identifier hit is kept only until a prose one appears.
            if (!snippets.has(path) || (identifierHits.has(path) && !identifier)) {
                snippets.set(path, snippet);

                if (identifier) {
                    identifierHits.add(path);
                } else {
                    identifierHits.delete(path);
                }
            }
        }
    } finally {
        options.signal?.removeEventListener("abort", abort);
    }

    return snippets;
}
