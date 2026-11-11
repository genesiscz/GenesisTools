import { describe, expect, test } from "bun:test";
import { Lang, parse } from "@ast-grep/napi";
import adoFetchOutsideApi from "./ado-fetch-outside-api.definition";
import cdpSocketOutsideConnect from "./cdp-socket-outside-connect.definition";
import cmuxSendOutsideSurfaceInput from "./cmux-send-outside-surface-input.definition";
import cmuxTreeOutsideReader from "./cmux-tree-outside-reader.definition";
import type { RosterDefinition } from "./define";
import doctorDirectDelete from "./doctor-direct-delete.definition";
import { planRosters } from "./generate";
import { ROSTER_DEFINITIONS, rosterGrowth } from "./index";
import launchctlOutsideLaunchdAgent from "./launchctl-outside-launchd-agent.definition";
import lockUnlinkOutsidePidfile from "./lock-unlink-outside-pidfile.definition";
import mcpProviderWriteOutsideCycle from "./mcp-provider-write-outside-cycle.definition";
import providerFetchOutsideExchange from "./provider-fetch-outside-exchange.definition";

function matches(definition: RosterDefinition, source: string): number {
    const root = parse(Lang.TypeScript, source).root();
    return root.findAll(definition.matcher).filter((node) => definition.test?.(node) ?? true).length;
}

describe("roster patterns", () => {
    test.each([
        [adoFetchOutsideApi, 'await fetch("https://dev.azure.com/x")', "await api.send(request)"],
        [providerFetchOutsideExchange, "return fetch(url, init)", "return this.fetch(url, init)"],
        [launchctlOutsideLaunchdAgent, 'spawn(["launchctl", "load", plist])', 'const label = "launchctl-like"'],
        [lockUnlinkOutsidePidfile, "unlinkSync(lockPath)", "unlinkSync(outputPath)"],
        [cmuxSendOutsideSurfaceInput, 'await runCmuxOk(["send", ...where, text])', 'z.enum(["send", "confirm"])'],
        [doctorDirectDelete, "await rm(path, { recursive: true })", "await removeByName(path)"],
        [cmuxTreeOutsideReader, 'await runCmux(["tree", "--all"])', 'runAx(["tree", "--app", app])'],
        [mcpProviderWriteOutsideCycle, "writeFileSync(path, text)", "process.stdout.write(text)"],
        [cdpSocketOutsideConnect, "const socket = new WebSocket(target.webSocketDebuggerUrl)", "connect(target, port)"],
    ])("%#: matches the pattern and not its look-alike", (definition, bad, good) => {
        expect(matches(definition, bad)).toBe(1);
        expect(matches(definition, good)).toBe(0);
    });

    test("every definition has a unique roster- name and a candidate", () => {
        const names = ROSTER_DEFINITIONS.map((definition) => definition.name);
        expect(new Set(names).size).toBe(names.length);

        for (const definition of ROSTER_DEFINITIONS) {
            expect(definition.name).toMatch(/^roster-[a-z0-9-]+$/);
            expect(definition.candidate).toMatch(/^[CF]\d+$/);
        }
    });
});

describe("planRosters", () => {
    test("seeds a new roster, lowers a count, drops a clean file and refuses growth", () => {
        const plan = planRosters(
            { "roster-a": { "src/one.ts": 2, "src/two.ts": 1 } },
            { "roster-a": { "src/one.ts": 1, "src/three.ts": 1 }, "roster-b": { "src/four.ts": 3 } }
        );

        expect(plan.next).toEqual({ "roster-a": { "src/one.ts": 1 }, "roster-b": { "src/four.ts": 3 } });
        expect(plan.grown).toEqual(["roster-a: src/three.ts has 1, the roster allows 0"]);
        expect(plan.shrunk).toEqual(["roster-a: src/one.ts 2 → 1", "roster-a: src/two.ts 1 → 0"]);
    });
});

describe("rosterGrowth", () => {
    test("names an entry edited up by hand and lets a new roster in", () => {
        expect(
            rosterGrowth(
                { "roster-a": { "src/one.ts": 1 } },
                { "roster-a": { "src/one.ts": 2, "src/two.ts": 1 }, "roster-new": { "src/x.ts": 4 } }
            )
        ).toEqual(["roster-a: src/one.ts 1 → 2", "roster-a: src/two.ts 0 → 1"]);
    });
});
