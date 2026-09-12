import { expect, test } from "bun:test";
import { assertTabInventoryUnchanged, fingerprintTabInventory } from "./browser-tabs";

test("literal AXTitle memory-like text remains distinct", () => {
    const expected = fingerprintTabInventory([
        { AXTitle: "Guide - High memory usage - 123 MB", AXDescription: "Shared" },
    ]);
    const actual = fingerprintTabInventory([
        { AXTitle: "Guide - Inactive tab - 456 MB freed up", AXDescription: "Shared" },
    ]);
    expect(() => assertTabInventoryUnchanged({ expected, actual })).toThrow("tab inventory changed");
});

test("ordinary title text resembling a memory label remains identity", () => {
    const expected = fingerprintTabInventory([{ AXDescription: "Guide - Memory usage - troubleshooting" }]);
    const actual = fingerprintTabInventory([{ AXDescription: "Guide - Memory usage - 123 MB" }]);
    expect(() => assertTabInventoryUnchanged({ expected, actual })).toThrow("tab inventory changed");
});

// Regression: PR #376 — equal tab counts do not prove the same ordered inventory.
test("same-count tab replacement is rejected", () => {
    const expected = fingerprintTabInventory([{ AXDescription: "First" }, { AXDescription: "Second" }]);
    const actual = fingerprintTabInventory([{ AXDescription: "First" }, { AXDescription: "Replacement" }]);
    expect(() => assertTabInventoryUnchanged({ expected, actual })).toThrow("tab inventory changed");
});

test("same-count tab reordering is rejected", () => {
    const expected = fingerprintTabInventory([{ AXDescription: "First" }, { AXDescription: "Second" }]);
    const actual = fingerprintTabInventory([{ AXDescription: "Second" }, { AXDescription: "First" }]);
    expect(() => assertTabInventoryUnchanged({ expected, actual })).toThrow("tab inventory changed");
});

test("memory status changes preserve the same observable tab identity", () => {
    const expected = fingerprintTabInventory([{ AXDescription: "First - Inactive tab - 123 MB freed up" }]);
    const actual = fingerprintTabInventory([{ AXDescription: "First - High memory usage - 456 MB" }]);
    expect(() => assertTabInventoryUnchanged({ expected, actual })).not.toThrow();
});

test("an explicit AX identifier distinguishes identical titles", () => {
    const expected = fingerprintTabInventory([{ AXDescription: "Same", AXIdentifier: "tab-one" }]);
    const actual = fingerprintTabInventory([{ AXDescription: "Same", AXIdentifier: "tab-two" }]);
    expect(() => assertTabInventoryUnchanged({ expected, actual })).toThrow("tab inventory changed");
});
