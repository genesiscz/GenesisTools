import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";

/**
 * `bun update --latest` rewrites a `"*"` range it cannot resolve into the dist-tag
 * `"latest"`. A dist-tag is not a semver range: `semver.validRange("latest")` is null,
 * so npm and pnpm cannot satisfy such a peer at all, and `@genesiscz/utils` is a
 * published package whose peers consumers do resolve. This caught two of them.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..");
const MANIFESTS = ["package.json", "src/utils/package.json"];

const RANGE_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/** Protocols bun resolves without going through semver at all. */
const NON_SEMVER_PROTOCOLS = /^(workspace|npm|file|link|catalog|portal|git|git\+ssh|git\+https|https?):/;

/** A range starts with a comparator, a digit or `v`; `*` alone is the any-version range. */
const LOOKS_LIKE_RANGE = /^(\*|[\^~><=v\d])/;

function rangesOf(manifest: string): Array<{ field: string; name: string; range: string }> {
    const raw = readFileSync(join(REPO_ROOT, manifest), "utf8");
    const json = SafeJSON.parse(raw) as Record<string, unknown>;
    const out: Array<{ field: string; name: string; range: string }> = [];

    for (const field of RANGE_FIELDS) {
        const block = json[field];

        if (!block || typeof block !== "object") {
            continue;
        }

        for (const [name, range] of Object.entries(block as Record<string, string>)) {
            out.push({ field, name, range });
        }
    }

    return out;
}

describe("workspace manifests", () => {
    it.each(MANIFESTS)("%s declares no dependency as a dist-tag", (manifest) => {
        const offenders = rangesOf(manifest)
            .filter(({ range }) => !NON_SEMVER_PROTOCOLS.test(range) && !LOOKS_LIKE_RANGE.test(range))
            .map(({ field, name, range }) => `${field}.${name} = ${range}`);

        expect(offenders).toEqual([]);
    });

    it.each(MANIFESTS)("%s declares at least one range, so the scan is not vacuous", (manifest) => {
        expect(rangesOf(manifest).length).toBeGreaterThan(50);
    });
});
