import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "@genesiscz/utils/paths";
import { historySourceKey, unresolvedHistorySourceKey } from "./identity";

test("source identity collapses symlink homes while separating providers and physical homes", () => {
    const root = mkdtempSync(join(tmpdir(), "history-identity-"));
    const home = join(root, "native");
    const otherHome = join(root, "other");
    const alias = join(root, "alias");
    mkdirSync(home);
    mkdirSync(otherHome);
    symlinkSync(home, alias, "dir");
    const identity = { providerId: "fixture-sub", nativeId: "one", sourceHome: home };
    const key = historySourceKey(identity);

    expect(historySourceKey({ ...identity, sourceHome: alias })).toBe(key);
    expect(
        new Set([
            key,
            historySourceKey({ ...identity, providerId: "another-sub" }),
            historySourceKey({ ...identity, sourceHome: otherHome }),
            historySourceKey({ ...identity, nativeId: "two" }),
            unresolvedHistorySourceKey({ providerId: "fixture-sub", filePath: join(home, "one") }),
        ]).size
    ).toBe(5);
    expect(() => historySourceKey({ ...identity, nativeId: "" })).toThrow();
});
