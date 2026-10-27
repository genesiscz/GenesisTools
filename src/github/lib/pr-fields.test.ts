import { describe, expect, test } from "bun:test";
import type { CommandRunner } from "@genesiscz/utils/git/origins/types";
import { SafeJSON } from "@genesiscz/utils/json";
import { readPrFields } from "./pr-fields";

function fakeGh(calls: string[][]): CommandRunner {
    return async (cmd) => {
        calls.push(cmd);

        if (cmd[0] === "git") {
            return { code: 0, stdout: "git@github.com:acme/widgets.git\n", stderr: "" };
        }

        if (cmd[2] === "view" && cmd[3] === "no-pr") {
            return { code: 1, stdout: "", stderr: 'no pull requests found for branch "no-pr"' };
        }

        if (cmd[2] === "view") {
            return { code: 0, stdout: SafeJSON.stringify({ number: 42, title: "Fix it", state: "OPEN" }), stderr: "" };
        }

        // gh pr checks exits 1 with a failed check: its output still counts.
        return { code: 1, stdout: SafeJSON.stringify([{ name: "lint", bucket: "fail" }]), stderr: "" };
    };
}

describe("readPrFields", () => {
    test("asks gh once, then serves the cached answer within the max age", async () => {
        const calls: string[][] = [];
        const ask = { input: "42", fields: ["title", "checks"], cwd: "/work/widgets", run: fakeGh(calls) };
        const first = await readPrFields({ ...ask, maxCacheAgeSeconds: 60 });

        expect(first.hit).toBe(false);
        expect(first.value).toEqual({
            pr: { number: 42, title: "Fix it", state: "OPEN" },
            checks: [{ name: "lint", bucket: "fail" }],
        });
        expect(calls.find((cmd) => cmd[2] === "view")).toContain("title,number");

        const second = await readPrFields({ ...ask, maxCacheAgeSeconds: 60 });
        expect(second.hit).toBe(true);
        expect(calls.filter((cmd) => cmd[0] === "gh")).toHaveLength(2);
    });

    test("a branch with no PR answers pr: null; another gh failure throws", async () => {
        const calls: string[][] = [];

        expect(
            (await readPrFields({ input: "no-pr", fields: ["number"], cwd: "/work/widgets", run: fakeGh(calls) })).value
        ).toEqual({ pr: null });

        const broken: CommandRunner = async (cmd) =>
            cmd[0] === "git" ? { code: 1, stdout: "", stderr: "" } : { code: 4, stdout: "", stderr: "HTTP 502" };
        await expect(readPrFields({ input: "7", fields: ["number"], cwd: "/work/x", run: broken })).rejects.toThrow(
            "HTTP 502"
        );
    });
});
