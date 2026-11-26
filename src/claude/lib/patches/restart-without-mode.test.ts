import { expect, test } from "bun:test";
import { applyPatches, inspectPatch, patchStatus } from "./apply";
import { definePatch } from "./define-patch";
import { restartWithoutModePatch } from "./restart-without-mode";

const source = `async function startup() {
    if (credentialsPending()) return "credentials";
    if (!settingsReady()||!verdictReady()) return "admin_unread";
    if (blocked()) return "admin";
}
async function example() {
    const banner = "Příliš 🐈";
    let principal = identity(), reason = !state.reviewed ? "no_setup"
        : noAdmin() ? "admin_unread"
        : changed(principal) ? "credential_changed"
        : blocked() ? "admin"
        : compliance() ? "compliance"
        : tracing() ? "otel"
        : provider() ? "provider"
        : model() ? "model" : void 0;
    if (reason !== void 0) return restart(reason, "restart_without_mode");
    return banner;
}`;
const version = "2.1.328";

test("matches renamed bindings and preserves UTF-8 size", () => {
    expect(patchStatus(source, restartWithoutModePatch, version)).toBe("applicable");
    const patched = applyPatches(source, [restartWithoutModePatch], version);
    expect(patched).toContain('const banner = "Příliš 🐈";');
    expect(patched).toContain('reason = "admin_unread"');
    expect(patched).toContain('if (true) return "admin_unread";');
    expect(patched).toContain('if (credentialsPending()) return "credentials";');
    expect(patched).not.toContain("!state.reviewed");
    expect(Buffer.byteLength(patched)).toBe(Buffer.byteLength(source));
    expect(patchStatus(patched, restartWithoutModePatch, version)).toBe("applied");
    expect(applyPatches(patched, [restartWithoutModePatch], version)).toBe(patched);
    const legacy = patched.replace('reason = "admin_unread"', `reason = ${"0".padEnd('"admin_unread"'.length)}`);
    expect(patchStatus(legacy, restartWithoutModePatch, version)).toBe("applicable");
    expect(applyPatches(legacy, [restartWithoutModePatch], version)).toBe(patched);
    const previousGuard = source.replace("!verdictReady())", "!verdictReady()||false)");
    expect(patchStatus(previousGuard, restartWithoutModePatch, version)).toBe("applicable");
    expect(applyPatches(previousGuard, [restartWithoutModePatch], version)).toContain(
        'if (true) return "admin_unread";'
    );
});

test("rejects ambiguous branches and mismatched reason bindings", () => {
    expect(inspectPatch(source + source.replace("example", "other"), restartWithoutModePatch, version)).toEqual({
        state: "incompatible",
        reason: "Expected one AST match in the selected module, found 0",
    });
    expect(patchStatus(source.replace("restart(reason", "restart(principal"), restartWithoutModePatch, version)).toBe(
        "incompatible"
    );
    expect(patchStatus(source.replace(".reviewed", ".unrelated"), restartWithoutModePatch, version)).toBe(
        "incompatible"
    );
    expect(
        patchStatus(source.replace('return "credentials";', 'return "other";'), restartWithoutModePatch, version)
    ).toBe("incompatible");
});
test("accepts any declared version range and reports an excluded or unknown version", () => {
    const patch = definePatch({
        id: "test-version",
        description: "Replace a test label",
        versions: [">=1.2.0 <2.0.0", "3.1.0"],
        find: "old",
        replace: "new",
    });

    expect(applyPatches("old", [patch], "1.2.0")).toBe("new");
    expect(patchStatus("new", patch, "3.1.0")).toBe("applied");
    expect(() => applyPatches("old", [patch], "2.0.0")).toThrow("2.0.0 does not match >=1.2.0 <2.0.0 or 3.1.0");
    expect(() => applyPatches("old", [patch])).toThrow("version could not be read from the entrypoint");
});
