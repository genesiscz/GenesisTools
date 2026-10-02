/**
 * fable-replace — `imports=fix` for a batch of moves: checks the batch, then hands each language's
 * moves to its planner. Every planner returns ordinary literal ops, so they ride in the same
 * transaction as the cut and the paste.
 */

import { planPhpImportFixes } from "./move-imports-php";
import { importLanguage, MoveError, markerWith, type PlanImportFixesParams, withFix } from "./move-imports-shared";
import { planSwiftImportFixes } from "./move-imports-swift";
import { planTsImportFixes } from "./move-imports-ts";
import type { FileEdit } from "./types";

export const planImportFixes = (params: PlanImportFixesParams): FileEdit[] => {
    const fixing = params.moves.filter((move) => move.fixImports);
    if (fixing.length === 0) {
        return [];
    }

    for (const move of params.moves) {
        // One source is planned as a whole: a binding is unused only once EVERY block has left.
        if (!move.fixImports && fixing.some((fix) => fix.fromAbs === move.fromAbs)) {
            throw new MoveError(
                withFix(`move: imports=fix must be on every move out of ${move.from} in one batch, or on none`, {
                    why: "add imports=fix to this marker too:",
                    spec: markerWith(move, "imports=fix"),
                }),
                move.index
            );
        }
    }

    for (const move of fixing) {
        const language = importLanguage(move.fromAbs);
        if (language === null) {
            throw new MoveError(
                withFix(`move: imports=fix knows TypeScript/JavaScript, Swift and PHP, not ${move.from}`, {
                    why: "drop imports=fix from this marker and fix the imports in ordinary ops:",
                    spec: move.marker.replace(" imports=fix", ""),
                }),
                move.index
            );
        }

        if (importLanguage(move.toAbs) !== language) {
            throw new MoveError(
                withFix(`move: ${move.from} and ${move.to} are different languages, so no import carries over`, {
                    why: "move into a file of the same language:",
                    spec: move.marker.replace(
                        `to=${move.to}`,
                        `to=${move.to.replace(/\.[^./]+$/, "")}${move.from.match(/\.[^./]+$/)?.[0] ?? ""}`
                    ),
                }),
                move.index
            );
        }
    }

    const forLanguage = (language: string): PlanImportFixesParams => ({
        ...params,
        moves: params.moves.filter((move) => importLanguage(move.fromAbs) === language),
    });
    return [
        ...planTsImportFixes(forLanguage("ts")),
        ...planSwiftImportFixes(forLanguage("swift")),
        ...planPhpImportFixes(forLanguage("php")),
    ];
};
