import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { stripAnsi } from "@genesiscz/utils/string";
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

/** The home's Codex state database, cut down to the one table the name merge touches. */
function stateDatabase(path: string, rows: Array<{ id: string; name?: string }>): string {
    const file = join(path, "state_5.sqlite");
    const database = new Database(file);
    database.exec("create table threads (id text primary key, name text)");

    for (const row of rows) {
        database.query("insert into threads (id, name) values (?, ?)").run(row.id, row.name ?? null);
    }

    database.close();

    return file;
}

function threadName(path: string, id: string): string | null {
    const database = new Database(join(path, "state_5.sqlite"), { readonly: true });

    try {
        return (database.query("select name from threads where id = ?").get(id) as { name: string | null }).name;
    } finally {
        database.close();
    }
}

/** Non-interactive, the shape a script or an agent runs the command in. */
function silent(): MigrateHomeInteraction {
    return {
        interactive: () => false,
        confirm: () => Promise.resolve(false),
        inspectOpenFiles: () => [],
    };
}

describe("runMigrateHome exit code", () => {
    test("--apply exits 1 when a destination state database refuses the name write", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-refused-"));
        const destination = home(root, ".codex", true);
        const source = home(root, ".codex-alpha", true);
        stateDatabase(source, [{ id: UUID, name: "astra-pricing" }]);
        const database = stateDatabase(destination, [{ id: UUID }]);
        // A read-only destination database stands in for every way the write can be refused: a
        // read-only volume, a permission the user lost, a SQLITE_BUSY past the 5 s timeout.
        chmodSync(database, 0o444);

        const previous = process.exitCode;
        process.exitCode = 0;

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: root }, () =>
            runMigrateHome({ from: [source], to: destination, apply: true }, silent())
        );

        // The check this pins reached `--json` and the interactive confirm only, so the ordinary
        // `--apply` run printed "1 state database(s) refused the write" and still exited 0.
        expect(process.exitCode).toBe(1);

        chmodSync(database, 0o644);
        process.exitCode = previous;
    });

    test("NEGATIVE CONTROL: the same --apply run exits 0 when the write lands", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-clean-"));
        const destination = home(root, ".codex", true);
        const source = home(root, ".codex-alpha", true);
        stateDatabase(source, [{ id: UUID, name: "astra-pricing" }]);
        stateDatabase(destination, [{ id: UUID }]);

        const previous = process.exitCode;
        process.exitCode = 0;

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: root }, () =>
            runMigrateHome({ from: [source], to: destination, apply: true }, silent())
        );

        expect(process.exitCode).toBe(0);
        expect(threadName(destination, UUID)).toBe("astra-pricing");

        process.exitCode = previous;
    });
});

/** Everything the command printed to stdout, with colour removed. */
async function captureStdout(run: () => Promise<void>): Promise<string> {
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    process.stdout.write = (chunk: string) => {
        chunks.push(String(chunk));
        return true;
    };

    try {
        await run();
        await Bun.sleep(10);
    } finally {
        process.stdout.write = original;
    }

    return stripAnsi(chunks.join(""));
}

describe("runMigrateHome report", () => {
    test("an applied run does not label its own skip and failure rows a dry run", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-label-"));
        const destination = home(root, ".codex", true);
        const source = home(root, ".codex-alpha", true);
        stateDatabase(source, [{ id: UUID, name: "astra-pricing" }]);
        const database = stateDatabase(destination, [{ id: UUID }]);
        chmodSync(database, 0o444);

        const previous = process.exitCode;
        const printed = await captureStdout(() =>
            env.testing.withOverrides({ GENESIS_TOOLS_HOME: root }, () =>
                runMigrateHome({ from: [source], to: destination, apply: true }, silent())
            )
        );

        // `written` stays false when the only outcome is a refusal, so the rows the refusal check
        // added printed under a "(dry run)" label while the header two lines up said "applied".
        expect(printed).toContain("applied");
        expect(printed).toContain("refused the write");
        expect(printed).not.toContain("(dry run)");

        chmodSync(database, 0o644);
        process.exitCode = previous;
    });
});

describe("runMigrateHome danger confirm", () => {
    test("a name the apply is going to skip is never promised by the confirm", async () => {
        const root = mkdtempSync(join(tmpdir(), "codex-migrate-cli-busy-"));
        const destination = home(root, ".codex", true);
        const source = home(root, ".codex-alpha", true);
        // The name lives only in the source's state database, so `session_index.jsonl` carries
        // nothing and the state write is the whole of the work the confirm can promise.
        stateDatabase(source, [{ id: UUID, name: "astra-pricing" }]);
        const database = stateDatabase(destination, [{ id: UUID }]);

        const asked: string[] = [];
        const answers = [false, false, true];
        let index = 0;
        const interaction: MigrateHomeInteraction = {
            interactive: () => true,
            inspectOpenFiles: (query) =>
                (query.files ?? []).includes(database) ? [{ pid: 4242, command: "codex", path: database }] : [],
            confirm(options) {
                asked.push(options.message);
                return Promise.resolve(answers[index++] ?? false);
            },
        };

        const previous = process.exitCode;

        await env.testing.withOverrides({ GENESIS_TOOLS_HOME: root }, () =>
            runMigrateHome({ from: [source], to: destination }, interaction)
        );

        // Codex holds the destination database, so the apply skips it. The plan did not model the
        // skip, promised "carry 1 name(s)", took a full backup on the yes, and carried nothing.
        expect(asked.map((message) => message.includes("name(s)"))).toEqual([false, false]);
        expect(threadName(destination, UUID)).toBeNull();

        process.exitCode = previous;
    });
});
