import { afterEach, describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "@app/utils/env";
import { grokAuthPath, grokConfigPath, grokModelsCachePath, grokVersionPath, resolveGrokHome } from "./paths";

describe("grok paths", () => {
    const previous = env.grok.getHome();

    afterEach(() => {
        if (previous === undefined) {
            env.testing.unset("GROK_HOME");
        } else {
            env.testing.set("GROK_HOME", previous);
        }
    });

    it("respects GROK_HOME override", () => {
        const home = join(tmpdir(), "grok-test-home");
        env.testing.set("GROK_HOME", home);
        expect(resolveGrokHome()).toBe(home);
        expect(grokAuthPath()).toBe(join(home, "auth.json"));
        expect(grokModelsCachePath()).toBe(join(home, "models_cache.json"));
        expect(grokVersionPath()).toBe(join(home, "version.json"));
        expect(grokConfigPath()).toBe(join(home, "config.json"));
    });
});
