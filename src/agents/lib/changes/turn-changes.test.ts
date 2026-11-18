import { expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
    claudeFixture,
    claudeFixtureNames,
    type Fixture,
} from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/claude-sessions";
import { codexFixture } from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/codex-sessions";
import { logOnlyFixture } from "@genesiscz/utils/agent-sessions/readers/fixtures/changes/log-only";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { sessionTurnChanges, turnChangesJson } from "./tool-changes";

const fixtures = [
    ...claudeFixtureNames.map((name) => ({ name, build: () => claudeFixture(name) })),
    { name: "codex", build: codexFixture },
    { name: "grok", build: logOnlyFixture },
];

function inFixture(f: Fixture, run: () => Promise<void>) {
    return env.testing.withOverrides(
        { GENESIS_TOOLS_HOME: f.home, CLAUDE_CONFIG_DIR: f.home, CODEX_HOME: f.home },
        run
    );
}

async function answer(f: Fixture, count: number) {
    const result = await sessionTurnChanges({ session: f.session, file: f.log, rows: f.rows, options: {}, count });
    if ("error" in result) {
        throw new Error(result.error);
    }
    return SafeJSON.stringify(turnChangesJson(f.session, f.log, {}, result), { strict: true }).replaceAll(
        f.home,
        "<home>"
    );
}

for (const { name, build } of fixtures) {
    it(`pins the last changed turns of ${name}`, async () => {
        const f = build();
        const path = new URL(
            `../../../utils/agent-sessions/readers/fixtures/changes/golden/${name}.json`,
            import.meta.url
        );
        const expected: Record<string, unknown> = SafeJSON.parse(readFileSync(path, "utf8"), { strict: true });
        await inFixture(f, async () => {
            for (const [count, golden] of Object.entries(expected)) {
                expect(SafeJSON.parse(await answer(f, Number(count)))).toEqual(golden);
            }
        });
    });
}
