import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { registerConfigOption } from "@app/azure-devops/commands/config-option";
import {
    findConfigPath,
    getExplicitConfigPath,
    getLocalConfigDir,
    loadConfig,
    requireConfig,
    setConfigFlag,
} from "@app/azure-devops/config";
import {
    azureDataDir,
    ConfigPathError,
    explicitConfigPath,
    resolveConfigPath,
    searchConfigPath,
} from "@app/azure-devops/lib/config-path";
import { getTasksDir } from "@app/azure-devops/task-files";
import { env } from "@genesiscz/utils/env";
import { SafeJSON } from "@genesiscz/utils/json";
import { out } from "@genesiscz/utils/logger";
import { Command } from "commander";

const CONFIG_JSON = SafeJSON.stringify({ org: "https://dev.azure.com/contoso", project: "Widgets" });

function tempDir(): string {
    return mkdtempSync(join(tmpdir(), "ado-config-path-"));
}

function writeConfig(root: string, name = "config.json"): string {
    const dir = join(root, ".claude/azure");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, name);
    writeFileSync(path, CONFIG_JSON);

    return path;
}

describe("resolveConfigPath", () => {
    test("--config wins over the environment variable and over a config the search would find", () => {
        const root = tempDir();
        const searched = writeConfig(join(root, "project"));
        const flagged = writeConfig(join(root, "flagged"));
        const fromEnv = writeConfig(join(root, "env"));

        expect(
            resolveConfigPath({ flag: flagged, envValue: fromEnv, searchFrom: dirname(dirname(searched)), cwd: root })
        ).toEqual({ path: flagged, source: "flag" });
    });

    test("the environment variable wins over the search", () => {
        const root = tempDir();
        const searched = writeConfig(join(root, "project"));
        const fromEnv = writeConfig(join(root, "env"));

        expect(resolveConfigPath({ envValue: fromEnv, searchFrom: dirname(dirname(searched)), cwd: root })).toEqual({
            path: fromEnv,
            source: "env",
        });
    });

    test("a blank flag or variable counts as not set, so the search runs", () => {
        const root = tempDir();
        const searched = writeConfig(root);

        expect(resolveConfigPath({ flag: "  ", envValue: "", searchFrom: root, cwd: root })).toEqual({
            path: searched,
            source: "search",
        });
    });

    test("a relative explicit path resolves against the working directory", () => {
        const root = tempDir();
        const path = writeConfig(root, "other.json");

        expect(resolveConfigPath({ flag: ".claude/azure/other.json", searchFrom: tempDir(), cwd: root })).toEqual({
            path,
            source: "flag",
        });
    });

    test("a missing explicit path is an error that names its source, even when the search would find a config", () => {
        const root = tempDir();
        writeConfig(root);
        const missing = join(root, "nowhere", "config.json");

        expect(() => resolveConfigPath({ flag: missing, searchFrom: root, cwd: root })).toThrow(ConfigPathError);
        expect(() => resolveConfigPath({ flag: missing, searchFrom: root, cwd: root })).toThrow(/--config/);
        expect(() => resolveConfigPath({ envValue: missing, searchFrom: root, cwd: root })).toThrow(
            /AZURE_DEVOPS_CONFIG/
        );
        expect(() => resolveConfigPath({ flag: missing, searchFrom: root, cwd: root })).toThrow(missing);
    });

    test("a folder is an error, not a config", () => {
        const root = tempDir();

        expect(() => resolveConfigPath({ flag: root, searchFrom: root, cwd: root })).toThrow(/not a file/);
    });

    test.skipIf(process.getuid?.() === 0)("an unreadable file is an error", () => {
        const root = tempDir();
        const path = writeConfig(root);
        chmodSync(path, 0o000);

        try {
            expect(() => resolveConfigPath({ flag: path, searchFrom: root, cwd: root })).toThrow(/cannot be read/);
        } finally {
            chmodSync(path, 0o600);
        }
    });

    test("the search still works when neither is given: this folder and three levels up, not four", () => {
        const root = tempDir();
        const config = writeConfig(root);
        const level3 = join(root, "a", "b", "c");
        const level4 = join(level3, "d");
        mkdirSync(level4, { recursive: true });

        expect(resolveConfigPath({ searchFrom: root, cwd: root })).toEqual({ path: config, source: "search" });
        expect(searchConfigPath(level3)).toBe(config);
        expect(searchConfigPath(level4)).toBeNull();
        expect(resolveConfigPath({ searchFrom: tempDir(), cwd: root })).toBeNull();
    });
});

describe("azureDataDir", () => {
    test("is the folder of an explicit config, otherwise .claude/azure in the working directory", () => {
        expect(azureDataDir({ flag: "/srv/ado/config.json", cwd: "/work" })).toBe("/srv/ado");
        expect(azureDataDir({ envValue: "/srv/env/config.json", cwd: "/work" })).toBe("/srv/env");
        expect(azureDataDir({ cwd: "/work" })).toBe(join("/work", ".claude/azure"));
        expect(explicitConfigPath({ cwd: "/work" })).toBeNull();
    });
});

describe("the active config", () => {
    let savedConfig: string | undefined;
    let savedCwd: string | undefined;

    beforeEach(() => {
        savedConfig = process.env.AZURE_DEVOPS_CONFIG;
        savedCwd = process.env.CLARITY_PROJECT_CWD;
        env.testing.unset("AZURE_DEVOPS_CONFIG");
        setConfigFlag(undefined);
    });

    afterEach(() => {
        setConfigFlag(undefined);

        for (const [key, value] of [
            ["AZURE_DEVOPS_CONFIG", savedConfig],
            ["CLARITY_PROJECT_CWD", savedCwd],
        ] as const) {
            if (value === undefined) {
                env.testing.unset(key);
            } else {
                env.testing.set(key, value);
            }
        }
    });

    test("the flag, then the variable, then the search choose the file", () => {
        const root = tempDir();
        const searched = writeConfig(join(root, "project"));
        const fromEnv = writeConfig(join(root, "env"));
        const flagged = writeConfig(join(root, "flagged"));
        env.testing.set("CLARITY_PROJECT_CWD", join(root, "project"));

        expect(findConfigPath()).toBe(searched);

        env.testing.set("AZURE_DEVOPS_CONFIG", fromEnv);
        expect(findConfigPath()).toBe(fromEnv);

        setConfigFlag(flagged);
        expect(findConfigPath()).toBe(flagged);
        expect(loadConfig()?.project).toBe("Widgets");
    });

    test("tasks and the config folder follow an explicit config", () => {
        const root = tempDir();
        const flagged = writeConfig(join(root, "flagged"));

        expect(getLocalConfigDir()).toBe(join(process.cwd(), ".claude/azure"));
        expect(getExplicitConfigPath()).toBeNull();

        setConfigFlag(flagged);

        expect(getLocalConfigDir()).toBe(dirname(flagged));
        expect(getTasksDir()).toBe(join(dirname(flagged), "tasks"));
        expect(getTasksDir("hotfixes")).toBe(join(dirname(flagged), "tasks", "hotfixes"));
        expect(getExplicitConfigPath()).toBe(flagged);
    });

    test("an explicit file that does not parse is an error, not a missing config", () => {
        const root = tempDir();
        const path = join(root, "broken.json");
        writeFileSync(path, "{ not json");
        setConfigFlag(path);

        expect(() => loadConfig()).toThrow(/cannot be parsed/);
    });

    test("requireConfig stops with a clear message when the explicit path is missing", () => {
        const root = tempDir();
        env.testing.set("CLARITY_PROJECT_CWD", root);
        writeConfig(root);
        setConfigFlag(join(root, "gone.json"));
        const printed = spyOn(out, "error").mockImplementation(() => undefined);
        const exited = spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
            throw new Error(`exit ${code}`);
        });

        try {
            expect(() => requireConfig()).toThrow("exit 1");
            expect(String(printed.mock.calls[0]?.[0])).toContain("gone.json");
        } finally {
            printed.mockRestore();
            exited.mockRestore();
        }
    });
});

describe("registerConfigOption", () => {
    afterEach(() => {
        setConfigFlag(undefined);
    });

    test("keeps --config before and after the subcommand, and clears it on a run without it", async () => {
        const program = new Command().exitOverride();
        registerConfigOption(program);
        program.command("sub").action(() => undefined);

        await program.parseAsync(["--config", "/srv/one/config.json", "sub"], { from: "user" });
        expect(getExplicitConfigPath()).toBe("/srv/one/config.json");

        const again = new Command().exitOverride();
        registerConfigOption(again);
        again.command("sub").action(() => undefined);
        await again.parseAsync(["sub", "--config", "/srv/two/config.json"], { from: "user" });
        expect(getExplicitConfigPath()).toBe("/srv/two/config.json");

        const plain = new Command().exitOverride();
        registerConfigOption(plain);
        plain.command("sub").action(() => undefined);
        await plain.parseAsync(["sub"], { from: "user" });
        expect(getExplicitConfigPath()).toBeNull();
    });

    test("--help describes the option and the variable", () => {
        const program = new Command();
        registerConfigOption(program);
        const option = program.options.find((item) => item.long === "--config");

        expect(option?.description).toContain("AZURE_DEVOPS_CONFIG");
    });
});
