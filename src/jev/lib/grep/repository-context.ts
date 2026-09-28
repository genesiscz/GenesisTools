import {
    type ContextTarget,
    defaultGatherers,
    gatherRepoContext,
    type RepoContextReader,
    type RepoLookup,
} from "@genesiscz/utils/repo-context";
import type { FilesystemReader, LookupResult, Snapshot } from "./filesystem";
import type { FileEvidence, RepositoryContext } from "./types";

function lookupStatus(result: LookupResult): RepoLookup {
    if (result.status === "file") {
        return "file";
    }

    if (result.status === "issue") {
        return "unreadable";
    }

    if (result.reason === "missing") {
        return "missing";
    }

    // `hidden` is decided from the name alone, before anything is stat'ed: the policy never looked.
    return result.reason === "hidden" ? "skipped" : "withheld";
}

/**
 * The grep side of `@genesiscz/utils/repo-context`: a reader over this search's eligibility policy, so
 * a gatherer sees exactly what the search could, and nothing above its root. Returned files are read
 * through `readCurrent`, which re-checks the content hash; manifests are read as fresh snapshots.
 */
export function grepContextReader({
    reader,
    returned,
    readCurrent,
}: {
    reader: Pick<FilesystemReader, "lookupFile" | "readSnapshot">;
    returned: ReadonlySet<string>;
    readCurrent: (path: string) => Promise<Snapshot | undefined>;
}): RepoContextReader {
    return {
        async lookup(path) {
            return lookupStatus(await reader.lookupFile(path));
        },
        async readText(path) {
            if (returned.has(path)) {
                return (await readCurrent(path))?.source;
            }

            const result = await reader.readSnapshot(path);
            return result.status === "ok" ? result.snapshot.source : undefined;
        },
    };
}

/** Locate scoped guidance, owning projects and test entry points. Executes nothing. */
export async function repositoryContext({
    reader,
    files,
    readCurrent,
}: {
    reader: Pick<FilesystemReader, "lookupFile" | "readSnapshot">;
    files: FileEvidence[];
    readCurrent: (path: string) => Promise<Snapshot | undefined>;
}): Promise<RepositoryContext> {
    // Upstream's rule: a file with no excerpt shows no test case, and `rendered` is what was shown.
    const targets: ContextTarget[] = files.map((file) => ({
        path: file.path,
        roles: file.roles,
        shownRanges: file.excerpts.length ? file.rendered : [],
    }));
    const { results, failed } = await gatherRepoContext({
        reader: grepContextReader({ reader, returned: new Set(files.map((file) => file.path)), readCurrent }),
        targets,
        gatherers: defaultGatherers(),
    });
    const testCommands = results.testCommands ?? [];
    return {
        instructionFiles: results.instructions?.files ?? [],
        instructionLookupIncomplete: results.instructions?.incomplete ?? true,
        pytestFiles: testCommands.filter((command) => command.runner === "pytest").map((command) => command.path),
        projects: results.projects ?? [],
        testCommands,
        failedGatherers: failed,
    };
}
