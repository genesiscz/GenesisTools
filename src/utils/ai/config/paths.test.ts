import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { env } from "@genesiscz/utils/env";
import { aiDataDir } from "./paths";

describe("aiDataDir", () => {
    test("returns the ai tool's base directory", () => {
        expect(aiDataDir()).toBe(join(env.tools.getHome() as string, ".genesis-tools", "ai"));
    });

    test("joins segments under it", () => {
        expect(aiDataDir("local-models")).toBe(join(aiDataDir(), "local-models"));
        expect(aiDataDir("local-models", "sherpa")).toBe(join(aiDataDir(), "local-models", "sherpa"));
    });

    test("follows GENESIS_TOOLS_HOME so the suite never touches a real config", () => {
        expect(aiDataDir()).toStartWith(env.tools.getHome() as string);
    });
});
