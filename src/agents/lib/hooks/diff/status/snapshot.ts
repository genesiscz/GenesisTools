import type { WatchDriverId } from "@genesiscz/utils/fs/watch-driver/registry";
import { callWorktreeSnapshot, requestServiceStart } from "@genesiscz/utils/genesis-tools/worktree/thin-client";
import type { SnapshotModeSettings, StatusArm, StatusCost, StatusModeModule } from "./types";

/**
 * One arm per driver, id `snapshot:<driver>`. `observe` is one `worktree.snapshot` call with the mark this arm left at
 * pre as `since`. A missing service also asks for a detached start. Every failure and every `unavailable` answer is
 * passed on as `unavailable` with its reason, so the hooks use Git. `changed` is recorded by the service and filters
 * nothing in this version.
 *
 * `serviceDir` is for a test with an isolated service; the hooks never pass it.
 */
export function snapshotArm(
    driver: WatchDriverId,
    settings: SnapshotModeSettings,
    options: { serviceDir?: string } = {}
): StatusArm {
    return {
        id: `snapshot:${driver}`,
        mode: "snapshot",
        async observe(request) {
            const call = await callWorktreeSnapshot(
                {
                    root: request.root,
                    driver,
                    fenceMs: settings.fenceMs,
                    ...(request.mark ? { since: request.mark } : {}),
                },
                { deadlineMs: settings.deadlineMs, ...(options.serviceDir ? { dir: options.serviceDir } : {}) }
            );
            const base: StatusCost = {
                cpuMs: 0,
                wallMs: call.wallMs,
                gitSpawns: 0,
                serviceCpuMs: null,
                fullStatus: false,
            };

            if (!call.ok) {
                if (call.reason === "no-service") {
                    requestServiceStart(options.serviceDir ? { dir: options.serviceDir } : {});
                }

                return { state: "unavailable", reason: call.reason, cost: base };
            }

            const result = call.result;

            if (result.state !== "ok") {
                return { state: "unavailable", reason: result.reason, cost: base };
            }

            return {
                state: "ok",
                view: { head: result.head, entries: result.entries },
                mark: result.mark,
                source: result.source,
                cost: { ...base, serviceCpuMs: result.cost.cpuMs, fullStatus: result.cost.fullStatus },
            };
        },
    };
}

export const snapshotMode: StatusModeModule<SnapshotModeSettings> = {
    primary: (settings) => snapshotArm(settings.driver, settings),
    variants: (settings) => settings.shadowDrivers.map((driver) => snapshotArm(driver, settings)),
};
