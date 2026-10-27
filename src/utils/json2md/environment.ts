import { relative } from "node:path";
import type { DocumentHints } from "@genesiscz/utils/json2md/document-file";

/**
 * What the json2md document verbs (`build`, `check`, `init`) need from the program that hosts them: the stamp's
 * rebuild command and the transclusion registry, the check that a module's package imports resolve, and the import
 * line `init` scaffolds. The verbs take it as a parameter, so a host that ships the utils without its own commands
 * passes its own environment instead of inheriting this program's.
 */
export interface DocumentEnvironment {
    /** The stamp's `command=` builder and the transclusion registry. */
    hints(): DocumentHints;
    /** The first folder in the module's import graph from which a package it needs does not resolve, or null. */
    unresolvedImporterDir(modulePath: string): Promise<string | null>;
    /** Prints why a package does not resolve from `dir`, and the one command that fixes it. */
    reportUnresolved(dir: string, severity: "warn" | "error"): void;
    /** The specifier `init` writes into a new document module's import line. */
    scaffoldSpecifier: string;
    /** Optional command for checking a generated document. */
    checkCommand?(modulePath: string): string;
    /** Optional command for overwriting a hand-edited generated document. */
    forceBuildCommand?(modulePath: string): string;
}

/** No hints, no resolve check: a document stamp carries no `command=` and every module loads as it is. */
export const NEUTRAL_DOCUMENT_ENVIRONMENT: DocumentEnvironment = {
    hints: () => ({}),
    unresolvedImporterDir: async () => null,
    reportUnresolved: () => undefined,
    scaffoldSpecifier: "@genesiscz/utils/json2md/document-file",
};

/** The shorter of the cwd-relative and absolute forms, so a `/tmp` path is not `../../../..`. */
export function shortPath(path: string): string {
    const rel = relative(process.cwd(), path);

    if (rel === "") {
        return path;
    }

    return rel.length < path.length ? rel : path;
}
