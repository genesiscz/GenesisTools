import { readHookStatus } from "@genesiscz/utils/git/hook-status";
import type { StatusArm, StatusModeModule, StatusModeSettings } from "./types";

/** The reference arm: today's one `git status` per root, through the shared argument list. */
const gitArm: StatusArm = {
    id: "git",
    mode: "git",
    async observe(request) {
        const read = readHookStatus(request.root, { trackedOnly: request.need === "deletions" });
        const cost = {
            cpuMs: read.cost.cpuMs,
            wallMs: read.cost.wallMs,
            gitSpawns: read.cost.spawns,
            serviceCpuMs: null,
            fullStatus: request.need === "all",
        };

        if (!read.ok) {
            return { state: "unavailable", reason: `git-${read.reason}`, cost };
        }

        return {
            state: "ok",
            view: { head: read.value.branch?.oid ?? null, entries: read.value.entries },
            mark: null,
            source: "git",
            cost,
        };
    },
};

export const gitMode: StatusModeModule<StatusModeSettings["git"]> = {
    primary: () => gitArm,
    variants: () => [],
};
