import { expect, test } from "bun:test";
import { ShareConfigSchema } from "@genesiscz/utils/genesis-tools/publish/store";
import { autoSyncTaskOptions, SHARE_AUTO_SYNC_TASK } from "./share-auto-sync";

test("the auto-sync task runs the main checkout's tools with --changed, every N minutes, and tells only on failure", () => {
    const options = autoSyncTaskOptions({ everyMinutes: 10, repoRoot: "/repo" });

    expect(options).toMatchObject({
        name: SHARE_AUTO_SYNC_TASK,
        every: "every 10 minutes",
        notify: "failure",
        overwrite: true,
    });
    expect(options.command).toBe("'/repo/tools' 'dev-dashboard' 'share' 'sync' '--all' '--changed'");
});

test("the share config keeps auto-sync per kind and refuses an interval out of range", () => {
    const base = { version: 2, defaults: {}, targets: [], servers: [] };

    expect(
        ShareConfigSchema.parse({ ...base, kinds: { md: { autoSync: { everyMinutes: 10 } } } }).kinds?.md?.autoSync
    ).toEqual({
        everyMinutes: 10,
    });
    expect(ShareConfigSchema.parse(base).kinds).toBeUndefined();
    expect(() => ShareConfigSchema.parse({ ...base, kinds: { md: { autoSync: { everyMinutes: 0 } } } })).toThrow();
});
