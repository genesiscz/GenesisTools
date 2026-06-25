import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearGithubCopilotTokenResolutionCache,
    copilotCliKeychainAccount,
    resolveGithubCopilotGhoToken,
} from "@app/utils/ai/github-copilot/copilot-cli-auth";
import { githubTokenPath } from "@app/utils/ai/github-copilot/paths";
import { env } from "@app/utils/env";
import { InMemoryBackend, setAuthStorageBackend } from "@app/utils/storage";

describe("copilot-cli-auth", () => {
    const GITHUB_TOKEN_KEYS = ["GITHUB_TOKEN", "GH_TOKEN", "GITHUB_PERSONAL_ACCESS_TOKEN"] as const;
    const envSnapshot = env.testing.snapshot();

    beforeEach(() => {
        setAuthStorageBackend(new InMemoryBackend());
        clearGithubCopilotTokenResolutionCache();
        env.testing.unset("COPILOT_GITHUB_TOKEN");
        for (const key of GITHUB_TOKEN_KEYS) {
            env.testing.unset(key);
        }
    });

    afterEach(() => {
        setAuthStorageBackend(null);
        clearGithubCopilotTokenResolutionCache();
        env.testing.restore(envSnapshot);
    });

    it("prefers data-dir token over env vars", async () => {
        const dataDir = join(tmpdir(), `copilot-auth-${Date.now()}`);
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(githubTokenPath(dataDir), "gho_from_file\n", "utf-8");
        env.testing.set("COPILOT_GITHUB_TOKEN", "gho_from_env");

        const resolved = await resolveGithubCopilotGhoToken({ dataDir, allowKeychain: true });

        expect(resolved).toEqual({ token: "gho_from_file", source: "data-dir" });

        rmSync(dataDir, { recursive: true, force: true });
    });

    it("uses COPILOT_GITHUB_TOKEN when data dir is empty", async () => {
        const dataDir = join(tmpdir(), `copilot-auth-env-${Date.now()}`);
        mkdirSync(dataDir, { recursive: true });
        env.testing.set("COPILOT_GITHUB_TOKEN", "gho_copilot_env");

        const resolved = await resolveGithubCopilotGhoToken({ dataDir, allowKeychain: false });

        expect(resolved).toEqual({ token: "gho_copilot_env", source: "copilot-github-token-env" });

        rmSync(dataDir, { recursive: true, force: true });
    });

    it("does not touch keychain when allowKeychain is false", async () => {
        const dataDir = join(tmpdir(), `copilot-auth-no-keychain-${Date.now()}`);
        mkdirSync(dataDir, { recursive: true });

        const resolved = await resolveGithubCopilotGhoToken({ dataDir, allowKeychain: false });

        expect(resolved).toBeNull();

        rmSync(dataDir, { recursive: true, force: true });
    });

    it("caches resolution for the process", async () => {
        const dataDir = join(tmpdir(), `copilot-auth-cache-${Date.now()}`);
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(githubTokenPath(dataDir), "gho_cached\n", "utf-8");

        const first = await resolveGithubCopilotGhoToken({ dataDir });
        writeFileSync(githubTokenPath(dataDir), "gho_changed\n", "utf-8");
        const second = await resolveGithubCopilotGhoToken({ dataDir });

        expect(first?.token).toBe("gho_cached");
        expect(second?.token).toBe("gho_cached");

        rmSync(dataDir, { recursive: true, force: true });
    });

    it("builds copilot-cli keychain account ids", () => {
        expect(copilotCliKeychainAccount("https://github.com", "genesiscz")).toBe("https://github.com:genesiscz");
    });
});
