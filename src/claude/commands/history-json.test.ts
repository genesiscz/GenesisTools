import { expect, spyOn, test } from "bun:test";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";
import { registerHistoryCommand } from "./history";

test("Claude empty history preserves the machine-readable array contract", async () => {
    const output = spyOn(out, "println").mockImplementation(() => undefined);
    try {
        const program = new Command().exitOverride();
        registerHistoryCommand(program);
        // Scoped to a project that cannot exist, so the empty-result shape is what is proven
        // rather than the machine's data. It used to lean on `--limit 0` short-circuiting to an
        // empty list, which stopped being true once 0 meant "no ceiling" again.
        await program.parseAsync(
            ["history", "gt-absent-fixture-token", "--project", "gt-absent-fixture-project", "--format", "json"],
            { from: "user" }
        );
        expect(output).toHaveBeenCalledWith("[]");
    } finally {
        output.mockRestore();
    }
}, 60_000);
