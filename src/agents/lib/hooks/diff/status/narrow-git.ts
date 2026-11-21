import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { worktreeGitDir } from "@genesiscz/utils/git/hook-status";
import {
    admitWorktree,
    headOf,
    indexHash,
    NARROW_REFUSALS,
    type NarrowAdmission,
    readNarrowStatus,
} from "@genesiscz/utils/git/narrow-status";
import { SafeJSON } from "@genesiscz/utils/json";
import { hookDiag } from "../../log";
import { narrowAdmissionPath } from "../../paths";
import type { StatusAnswer, StatusArm, StatusCost, StatusModeModule, StatusModeSettings } from "./types";

/** An unknown `v`, a missing file or a damaged one reads as "not admitted", so the next call admits again. */
function readAdmission(path: string): NarrowAdmission | null {
    if (!existsSync(path)) {
        return null;
    }

    try {
        const raw: unknown = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });

        if (
            typeof raw === "object" &&
            raw !== null &&
            "v" in raw &&
            raw.v === 1 &&
            "head" in raw &&
            typeof raw.head === "string" &&
            "indexHash" in raw &&
            typeof raw.indexHash === "string" &&
            "admitted" in raw &&
            typeof raw.admitted === "boolean"
        ) {
            const refusal = "refusal" in raw ? NARROW_REFUSALS.find((name) => name === raw.refusal) : undefined;
            return {
                v: 1,
                head: raw.head,
                indexHash: raw.indexHash,
                admitted: raw.admitted,
                ...(refusal ? { refusal } : {}),
            };
        }
    } catch (error) {
        hookDiag("a narrow-git admission record could not be read, so the worktree is admitted again", {
            path,
            error: String(error),
        });
    }

    return null;
}

function writeAdmission(path: string, admission: NarrowAdmission): void {
    try {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temporary = `${path}.${process.pid}.tmp`;
        writeFileSync(temporary, SafeJSON.stringify(admission), { mode: 0o600 });
        renameSync(temporary, path);
    } catch (error) {
        hookDiag("a narrow-git admission record could not be written", { path, error: String(error) });
    }
}

function costOf(read: { cpuMs: number; wallMs: number; spawns: number }, fullStatus: boolean): StatusCost {
    return { cpuMs: read.cpuMs, wallMs: read.wallMs, gitSpawns: read.spawns, serviceCpuMs: null, fullStatus };
}

const NO_GIT: StatusCost = { cpuMs: 0, wallMs: 0, gitSpawns: 0, serviceCpuMs: null, fullStatus: false };

/**
 * No service. At each boundary the index hash and HEAD are compared with the admission record. Equal and admitted: the
 * narrow reads (`git diff --name-status`, plus `ls-files --others` when all is needed), then the hash again; a changed
 * hash discards the answer (`raced`). Not equal: one full status admits the worktree again, and that status is this
 * call's answer. Only the admission is cached, never "this file was clean".
 */
const narrowArm: StatusArm = {
    id: "narrow-git",
    mode: "narrow-git",
    async observe(request): Promise<StatusAnswer> {
        const gitDir = worktreeGitDir(request.root);

        if (!gitDir) {
            return { state: "unavailable", reason: "not-a-worktree", cost: NO_GIT };
        }

        const path = narrowAdmissionPath(request.root);
        const record = readAdmission(path);
        const hash = indexHash(gitDir);
        const head = headOf(gitDir);

        if (record && hash && head && record.indexHash === hash && record.head === head) {
            if (!record.admitted) {
                return { state: "unavailable", reason: `refused-${record.refusal ?? "unknown"}`, cost: NO_GIT };
            }

            const narrow = readNarrowStatus(request.root, { need: request.need });

            if (!narrow.ok) {
                return { state: "unavailable", reason: `narrow-${narrow.reason}`, cost: costOf(narrow.cost, false) };
            }

            if (indexHash(gitDir) !== hash) {
                return { state: "unavailable", reason: "raced", cost: costOf(narrow.cost, false) };
            }

            return {
                state: "ok",
                view: { head, entries: narrow.value },
                mark: null,
                source: "narrow",
                cost: costOf(narrow.cost, false),
            };
        }

        const { admission, status } = admitWorktree(request.root, { head, gitDir });

        if (admission) {
            writeAdmission(path, admission);
        }

        if (!status.ok) {
            return { state: "unavailable", reason: "git-failed", cost: costOf(status.cost, true) };
        }

        return {
            state: "ok",
            view: { head: status.value.branch?.oid ?? head, entries: status.value.entries },
            mark: null,
            source: "admission",
            cost: costOf(status.cost, true),
        };
    },
};

export const narrowGitMode: StatusModeModule<StatusModeSettings["narrow-git"]> = {
    primary: () => narrowArm,
    variants: () => [],
};
