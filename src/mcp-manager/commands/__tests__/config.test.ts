import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { setupStorageSandbox } from "@app/utils/storage/test-sandbox";
import { setupInquirerMock } from "./inquirer-mock.js";

// openConfig() gates spawning the editor behind isInteractive(); setupInquirerMock
// stubs it true. Must run before the command module is imported, so the command
// is loaded dynamically below (mirrors install.test.ts).
setupInquirerMock();
setupStorageSandbox();

const { openConfig } = await import("@app/mcp-manager/commands/config.js");

import { logger } from "@app/logger";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import { env } from "@app/utils/env";
import { Storage } from "@app/utils/storage";

describe("openConfig", () => {
    // spyOn(Bun,'spawn'/Storage/...) is process-global in bun and not
    // auto-restored across files — restore so it can't leak into later suites.
    afterEach(() => {
        mock.restore();
    });

    it("should create default config if it doesn't exist", async () => {
        const mockConfigPath = "/mock/config.json";

        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue(null);
        spyOn(Storage.prototype, "setConfig").mockResolvedValue(undefined);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        // Mock Bun.spawn
        const _mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as unknown as ReturnType<typeof Bun.spawn>
        );

        await openConfig();

        expect(Storage.prototype.setConfig).toHaveBeenCalledWith({
            mcpServers: {},
        });
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Created default config"));
    });

    it("should open existing config in editor", async () => {
        const mockConfigPath = "/mock/config.json";
        const mockConfig = { mcpServers: { test: {} } };

        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as unknown as ReturnType<typeof Bun.spawn>
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Config file:"));
    });

    it("should use EDITOR environment variable", async () => {
        const originalVisual = env.editor.getVisual();
        const originalEditor = env.editor.getEditor();
        env.testing.unset("VISUAL");
        env.testing.set("EDITOR", "vim");

        const mockConfigPath = "/mock/config.json";
        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as unknown as ReturnType<typeof Bun.spawn>
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                cmd: expect.arrayContaining(["vim", mockConfigPath]),
            })
        );

        if (originalVisual) {
            env.testing.set("VISUAL", originalVisual);
        } else {
            env.testing.unset("VISUAL");
        }
        if (originalEditor) {
            env.testing.set("EDITOR", originalEditor);
        } else {
            env.testing.unset("EDITOR");
        }
    });

    it("should prefer VISUAL over EDITOR", async () => {
        const originalVisual = env.editor.getVisual();
        const originalEditor = env.editor.getEditor();
        env.testing.set("VISUAL", "emacs");
        env.testing.set("EDITOR", "vim");

        const mockConfigPath = "/mock/config.json";
        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as unknown as ReturnType<typeof Bun.spawn>
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                cmd: expect.arrayContaining(["emacs", mockConfigPath]),
            })
        );

        if (originalVisual) {
            env.testing.set("VISUAL", originalVisual);
        } else {
            env.testing.unset("VISUAL");
        }
        if (originalEditor) {
            env.testing.set("EDITOR", originalEditor);
        } else {
            env.testing.unset("EDITOR");
        }
    });

    it("should handle editor command with arguments", async () => {
        const originalVisual = env.editor.getVisual();
        const originalEditor = env.editor.getEditor();
        env.testing.unset("VISUAL");
        env.testing.set("EDITOR", "code --wait");

        const mockConfigPath = "/mock/config.json";
        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as unknown as ReturnType<typeof Bun.spawn>
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                cmd: expect.arrayContaining(["code", "--wait", mockConfigPath]),
            })
        );

        if (originalVisual) {
            env.testing.set("VISUAL", originalVisual);
        } else {
            env.testing.unset("VISUAL");
        }
        if (originalEditor) {
            env.testing.set("EDITOR", originalEditor);
        } else {
            env.testing.unset("EDITOR");
        }
    });
});
