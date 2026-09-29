/**
 * Repository context gatherers: what a coding agent should know about the tree around a set of
 * files before it edits them. Agent instruction files, the project that owns each file and what it
 * runs on, and a test command per shown test case.
 *
 * A gatherer reads only through a `RepoContextReader`, which the caller builds over its own
 * eligibility policy and root. Nothing here walks the disk directly, spawns git, or reads above the
 * root. `tools jev grep` is the first caller (`src/jev/lib/grep/repository-context.ts`).
 */
export { ancestorsOf, contextDirectories, gatherRepoContext, joinRelative, memoizeReader, relativeTo } from "./gather";
export {
    INSTRUCTION_FILE_NAMES,
    type InstructionFiles,
    instructionFilesGatherer,
    ROOT_INSTRUCTION_FILES,
} from "./instructions";
export {
    createProjectLocator,
    ECOSYSTEMS,
    type Ecosystem,
    type OwnedProject,
    type ProjectInfo,
    type ProjectLocator,
    projectsGatherer,
    type TestRunner,
} from "./projects";
export { coveredBy, isTestFilePath, locateTestCases } from "./test-cases";
export { type TestCommand, testCommandFor, testCommandsGatherer } from "./test-commands";
export type {
    ContextGatherer,
    ContextTarget,
    GathererResult,
    GatherOutcome,
    GatherScope,
    LineRange,
    RepoContextReader,
    RepoLookup,
} from "./types";

import { instructionFilesGatherer } from "./instructions";
import { projectsGatherer } from "./projects";
import { testCommandsGatherer } from "./test-commands";

/** The standard set. A caller that needs fewer passes its own list to `gatherRepoContext`. */
export function defaultGatherers() {
    return [instructionFilesGatherer(), projectsGatherer(), testCommandsGatherer()] as const;
}
