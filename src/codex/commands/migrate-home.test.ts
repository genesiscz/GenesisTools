import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SafeJSON } from "@genesiscz/utils/json";
import { Command } from "commander";
import { type MigrateHomeInteraction, registerMigrateHomeCommand, runMigrateHome } from "./migrate-home";

/**
 * The order of the two questions is load-bearing. `--archive-source` refuses against a source
 * a live process holds, and the plan is what evaluates refusals — so asking about archiving
 * AFTER the copy confirm meant the user could answer "yes, copy 3 rollouts" and "yes, archive",
 * and the apply run then refused and copied nothing.
 */

const UUID = "01a07dd8-4417-7be3-b922-74db43df0001";

function home(root: string, name: string, withRollout: boolean): string {
    const path = join(root, name);
    const day = join(path, "sessions", "2026", "09", "07");
    mkdirSync(day, { recursive: true });

    if (withRollout) {
        writeFileSync(
            join(day, `rollout-2026-09-07T00-00-00-${UUID}.jsonl`),
            `${SafeJSON.stringify({ type: "session_meta", payload: { id: UUID, cwd: "/projects/x" } })}\n`
        );
    }

    return path;
}

function scripted(answers: boolean[]): MigrateHomeInteraction & { asked: string[] } {
    const asked: string[] = [];
    let index = 0;

    return {
        asked,
        interactive: () => true,
        // Never the real probe: it shells out to `lsof`, which starves under a parallel suite.
        inspectOpenFiles: () => [],
        confirm(options) {
            asked.push(options.message);
            return Promise.resolve(answers[index++] ?? false);
        },
    };
}

describe("runMigrateHome question order", () => {
    test("archiving is settled before the plan, so the copy confirm is the last question", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-"));
        const destination = home(root, ".codex", false);
        home(root, ".codex-alpha", true);

        // desktop: no, archive: no, copy: no — nothing is written, only the order is asserted.
        const interaction = scripted([false, false, false]);
        await runMigrateHome({ from: [join(root, ".codex-alpha")], to: destination }, interaction);

        expect(interaction.asked).toHaveLength(3);
        expect(interaction.asked[0]).toContain("Codex Desktop");
        expect(interaction.asked[1]).toContain("sessions.migrated-");
        expect(interaction.asked[2]).toContain("Copy 1 rollout(s)");
        expect(readdirSync(join(destination, "sessions"))).toEqual(["2026"]);
    });

    test("--archive-source given on the command line asks neither archiving question", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-flag-"));
        const destination = home(root, ".codex", false);
        home(root, ".codex-alpha", true);

        const interaction = scripted([false, false]);
        await runMigrateHome(
            { from: [join(root, ".codex-alpha")], to: destination, desktop: true, archiveSource: true },
            interaction
        );

        expect(interaction.asked).toEqual([expect.stringContaining("Copy 1 rollout(s)")]);
    });
});

describe("the registered command", () => {
    test("runs, because commander's second argument never lands on the interaction", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-register-"));
        const program = new Command();
        registerMigrateHomeCommand(program);
        const previous = process.exitCode;

        // A bare `.action(runMigrateHome)` handed the Command object to the injected interaction,
        // and every invocation threw `interaction.interactive is not a function` on the FIRST line
        // of the command. A destination that does not exist is refused before the run inspects
        // anything, so this proves the wiring and never reaches a probe or the filesystem walk.
        await expect(
            program.parseAsync(["migrate-home", "--json", "--to", join(root, "absent-home")], { from: "user" })
        ).resolves.toBeDefined();
        expect(process.exitCode).toBe(1);

        process.exitCode = previous;
    });
});
