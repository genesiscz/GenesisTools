import { describe, expect, test } from "bun:test";
import { buildViteDevCmd, DEFAULT_BIND_HOST } from "./viteSpawn";

describe("buildViteDevCmd", () => {
    test("defaults to localhost bind", () => {
        const cmd = buildViteDevCmd({ configPath: "/tmp/vite.config.ts", strictPort: true });

        expect(cmd).toContain("--host");
        expect(cmd).toContain(DEFAULT_BIND_HOST);
        expect(cmd).toContain("--strictPort");
    });

    test("supports all-interfaces bind", () => {
        const cmd = buildViteDevCmd({
            configPath: "/tmp/vite.config.ts",
            bindHost: "0.0.0.0",
            port: 3071,
        });

        expect(cmd).toEqual(expect.arrayContaining(["--host", "0.0.0.0", "--port", "3071"]));
    });
});
