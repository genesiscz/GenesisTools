import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileListingFreshness, withoutListingReuse } from "./listing-freshness";

test("a recent refresh is reused, except inside withoutListingReuse, and the marker stays for others", async () => {
    const freshness = fileListingFreshness(join(mkdtempSync(join(tmpdir(), "listing-fresh-")), "markers"));
    freshness.touch("codex");

    expect(freshness.age("codex")).toBeLessThan(60_000);
    expect(await withoutListingReuse(async () => freshness.age("codex"))).toBeNull();
    expect(freshness.age("codex")).toBeLessThan(60_000);
});
