import { createHash } from "node:crypto";
import { SafeJSON } from "@genesiscz/utils/json";

interface TabIdentity {
    AXIdentifier?: string;
    AXTitle?: string;
    AXDescription?: string;
}

function stableLabel(value: string | undefined): string {
    return (value ?? "").replace(
        / - (?:Inactive tab(?: - [\d.,]+ (?:KB|MB|GB) freed up)?|(?:Memory usage|High memory usage) - [\d.,]+ (?:KB|MB|GB))$/,
        ""
    );
}

export function fingerprintTabInventory(tabs: readonly TabIdentity[]): string[] {
    return tabs.map((tab) =>
        createHash("sha256")
            .update(SafeJSON.stringify([tab.AXIdentifier ?? "", tab.AXTitle ?? "", stableLabel(tab.AXDescription)]))
            .digest("hex")
    );
}

export function assertTabInventoryUnchanged({
    expected,
    actual,
}: {
    expected: readonly string[];
    actual: readonly string[];
}): void {
    if (expected.length !== actual.length || expected.some((fingerprint, index) => fingerprint !== actual[index])) {
        throw new Error("browser tab inventory changed; inspect again before selecting by ordinal");
    }
}
