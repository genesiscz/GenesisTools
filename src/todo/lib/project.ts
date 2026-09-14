import { resolve } from "node:path";
import { shellQuote } from "@genesiscz/utils/shell/quote";
import { findProjectRoot } from "./context";
import { TodoStore } from "./store";
import type { Todo } from "./types";

/**
 * Every command takes the same `--project` flag, described the same way, because
 * an id created under one project root is invisible from any other cwd.
 */
export const PROJECT_OPTION_DESCRIPTION =
    "Project root that owns the todo (default: the git root of the cwd). Ids are per-project, not global.";

/** The project a command operates on: the explicit `--project`, else the git root of the cwd. */
export function resolveProjectRoot(flag: string | undefined): string {
    if (flag) {
        return resolve(flag);
    }

    return findProjectRoot(process.cwd()) ?? process.cwd();
}

export function storeForProject(flag: string | undefined): TodoStore {
    return TodoStore.forProject(resolveProjectRoot(flag));
}

/** A bareword needs no quoting at all; anything else goes through the shared, hardened quoter. */
const SAFE_BAREWORD = /^[A-Za-z0-9_./:=,@+-]+$/;

function quoteArg(arg: string): string {
    if (SAFE_BAREWORD.test(arg)) {
        return arg;
    }

    return shellQuote(arg);
}

/**
 * The same command the user just ran, re-pointed at the project that owns the id.
 * Built from the real argv so the hint is copy-pasteable rather than a guess at
 * which flags were passed.
 */
export function rerunWithProjectCommand(projectRoot: string): string {
    const args: string[] = [];
    let replaced = false;
    const source = process.argv.slice(2);

    for (let i = 0; i < source.length; i++) {
        const arg = source[i];

        // An explicit --project that does not hold the id is exactly the mistake
        // being reported, so its VALUE is replaced. Echoing it back unchanged
        // would print the failing command as its own fix.
        if (arg === "--project") {
            args.push(arg, quoteArg(projectRoot));
            replaced = true;
            i++;
            continue;
        }

        if (arg.startsWith("--project=")) {
            args.push(`--project=${quoteArg(projectRoot)}`);
            replaced = true;
            continue;
        }

        args.push(quoteArg(arg));
    }

    if (!replaced) {
        args.push("--project", quoteArg(projectRoot));
    }

    return `tools todo ${args.join(" ")}`;
}

/**
 * `findTodo` reports an empty root when a store directory has neither a
 * `meta.json` nor a todo carrying its own context — an imported todo whose
 * metadata was later removed. Printing that verbatim produced `id lives in:`
 * with nothing after it, and a `--project ` hint with no path.
 */
export const UNRECORDED_ROOT = "an unrecorded project root";

export interface MissingTodoReport {
    /** Where the id actually lives, when some other project store holds it. */
    found: { todo: Todo; projectRoot: string } | null;
    /** stderr lines, most specific first. */
    lines: string[];
    /** The same lines as one block, for a single `out.error` call. */
    message: string;
}

/**
 * Explain a missing id instead of printing a bare "Todo not found".
 *
 * A bare message reads as "this id does not exist", when the usual cause is that
 * the caller's cwd hashes to a different project store than the `--project` the
 * id was created with (observed 2026-09-09: `sync` run from a code repo against
 * an id created under a notes project).
 */
export async function reportMissingTodo(id: string, searchedProjectRoot: string): Promise<MissingTodoReport> {
    const found = await TodoStore.findTodo(id);

    if (!found) {
        const lines = [
            `Todo not found: ${id}`,
            `  searched project: ${searchedProjectRoot}`,
            "  No other project store holds this id either. `tools todo list --all` lists every project.",
        ];

        return { found: null, lines, message: lines.join("\n") };
    }

    if (!found.projectRoot) {
        const unrecorded = [
            `Todo not found in this project: ${id}`,
            `  searched project: ${searchedProjectRoot}`,
            `  id lives in:      ${UNRECORDED_ROOT} — its store has no meta.json`,
            "  `tools todo list --all` lists every project.",
        ];

        return { found, lines: unrecorded, message: unrecorded.join("\n") };
    }

    const lines = [
        `Todo not found in this project: ${id}`,
        `  searched project: ${searchedProjectRoot}`,
        `  id lives in:      ${found.projectRoot}`,
        `  re-run with:      ${rerunWithProjectCommand(found.projectRoot)}`,
    ];

    return { found, lines, message: lines.join("\n") };
}
