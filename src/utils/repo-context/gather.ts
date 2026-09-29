import { posix } from "node:path";
import { logger } from "@genesiscz/utils/logger";
import { profiler } from "@genesiscz/utils/profile";
import type { ContextGatherer, ContextTarget, GatherOutcome, RepoContextReader, RepoLookup } from "./types";

const { log } = logger.scoped("repo-context");
const prof = profiler.scope("repo-context");

/** `.` then every ancestor of every target, shallow before deep, so "nearest" walks are cheap to reason about. */
export function contextDirectories(targets: readonly ContextTarget[]): string[] {
    const directories = new Set(["."]);
    for (const target of targets) {
        for (let directory = posix.dirname(target.path); directory !== "."; directory = posix.dirname(directory)) {
            directories.add(directory);
        }
    }

    return [...directories].sort((a, b) => depth(a) - depth(b) || (a < b ? -1 : a > b ? 1 : 0));
}

function depth(directory: string): number {
    return directory === "." ? 0 : directory.split("/").length;
}

/** `dir/name`, or `name` at the root. */
export function joinRelative(directory: string, name: string): string {
    return directory === "." ? name : `${directory}/${name}`;
}

/** The directory itself, then each parent up to and including `.`. */
export function ancestorsOf(directory: string): string[] {
    const chain = [directory];
    for (let current = directory; current !== "."; ) {
        current = posix.dirname(current);
        chain.push(current);
    }

    return chain;
}

/** Relative path of `path` as seen from `directory`, both relative to the same root. */
export function relativeTo(directory: string, path: string): string {
    return directory === "." ? path : posix.relative(directory, path);
}

/**
 * Several gatherers ask about the same `package.json` or the same directory. One lookup and one
 * read per path per gather keeps a wide search from reading a manifest once per returned file.
 */
export function memoizeReader(reader: RepoContextReader): RepoContextReader {
    const lookups = new Map<string, Promise<RepoLookup>>();
    const texts = new Map<string, Promise<string | undefined>>();
    return {
        lookup(path) {
            let found = lookups.get(path);
            if (!found) {
                found = reader.lookup(path);
                lookups.set(path, found);
            }

            return found;
        },
        readText(path) {
            let text = texts.get(path);
            if (!text) {
                text = reader.readText(path);
                texts.set(path, text);
            }

            return text;
        },
    };
}

/**
 * Run every gatherer against one shared, memoized reader. A gatherer that throws is logged and
 * named in `failed`; the others still report. Cancellation is the one error that propagates.
 */
export async function gatherRepoContext<G extends ContextGatherer>({
    reader,
    targets,
    gatherers,
    signal,
}: {
    reader: RepoContextReader;
    targets: readonly ContextTarget[];
    gatherers: readonly G[];
    signal?: AbortSignal;
}): Promise<GatherOutcome<G>> {
    const scope = { reader: memoizeReader(reader), targets, directories: contextDirectories(targets), signal };
    const results: Record<string, unknown> = {};
    const failed: string[] = [];
    await Promise.all(
        gatherers.map(async (gatherer) => {
            const stop = prof.start(gatherer.id);
            try {
                results[gatherer.id] = await gatherer.gather(scope);
                log.debug(
                    { gatherer: gatherer.id, targets: targets.length, ms: Math.round(stop()) },
                    "Repository context gathered"
                );
            } catch (error) {
                stop();
                signal?.throwIfAborted();
                log.warn({ gatherer: gatherer.id, error }, "Repository context gatherer failed");
                failed.push(gatherer.id);
            }
        })
    );
    return { results: results as GatherOutcome<G>["results"], failed: failed.sort() };
}
