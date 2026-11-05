import { expect, test } from "bun:test";
import { loadTable } from "./layer-cut-tables/load";
import unified from "./layer-cut-tables/unified";

test("default table and explicit unified module preserve the same cut", async () => {
    expect(await loadTable([])).toBe(unified);
    expect(await loadTable(["--table", `${import.meta.dir}/layer-cut-tables/unified.ts`])).toBe(unified);
});

test("--table selects a complete alternate cut without changing the default", async () => {
    const table = await loadTable(["--table", `${import.meta.dir}/layer-cut-tables/722.ts`]);
    expect(table.selection).toBe("diff");
    expect(table.branches).toHaveLength(7);
    expect(table.defaults.base).toBe("origin/feat/2026-11-03-ai-usage-6-review-followups");
    expect(table.refPrefix).toBe("refs/heads/cut/722/");
    expect(await loadTable([])).toBe(unified);
});

test("--table requires a module path", async () => {
    await expect(loadTable(["--table"])).rejects.toThrow("requires a path");
    await expect(loadTable(["--table", "--tests"])).rejects.toThrow("requires a path");
});
