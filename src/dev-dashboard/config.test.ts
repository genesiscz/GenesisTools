import { describe, expect, it } from "bun:test";
import { resolveVaultRoot } from "@app/utils/obsidian/config";
import { resolveDashboardVault } from "./config";

describe("dev-dashboard obsidian vault", () => {
    it("resolves via the shared src/utils/obsidian resolver, not a hardcoded schema default", () => {
        // The intent of dropping the hardcoded default: the value now comes
        // from the shared resolver. (It may legitimately equal the user's real
        // vault path — that's discovery working, not a hardcoded constant.)
        expect(resolveDashboardVault()).toBe(resolveVaultRoot());
    });

    it("an explicit per-dashboard override wins over discovery", () => {
        expect(resolveDashboardVault("/explicit/override")).toBe("/explicit/override");
    });
});
