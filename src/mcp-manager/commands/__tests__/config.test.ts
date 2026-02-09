import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import logger from "@app/logger";
import { openConfig } from "@app/mcp-manager/commands/config.js";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import { Storage } from "@app/utils/storage";

describe("openConfig", () => {
    beforeEach(() => {
        // Reset mocks
    });

    it("should create default config if it doesn't exist", async () => {
        const mockConfigPath = "/mock/config.json";

        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue(null);
        spyOn(Storage.prototype, "setConfig").mockResolvedValue(undefined);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        // Mock Bun.spawn
        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as any
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
                }) as any
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Config file:"));
    });

    it("should use EDITOR environment variable", async () => {
        const originalEditor = process.env.EDITOR;
        process.env.EDITOR = "vim";

        const mockConfigPath = "/mock/config.json";
        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as any
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                cmd: expect.arrayContaining(["vim", mockConfigPath]),
            })
        );

        if (originalEditor) {
            process.env.EDITOR = originalEditor;
        } else {
            delete process.env.EDITOR;
        }
    });

    it("should handle editor command with arguments", async () => {
        const originalEditor = process.env.EDITOR;
        process.env.EDITOR = "code --wait";

        const mockConfigPath = "/mock/config.json";
        spyOn(Storage.prototype, "ensureDirs").mockResolvedValue(undefined);
        spyOn(Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");

        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(
            () =>
                ({
                    exited: Promise.resolve({ exitCode: 0 }),
                }) as any
        );

        await openConfig();

        expect(mockSpawn).toHaveBeenCalledWith(
            expect.objectContaining({
                cmd: expect.arrayContaining(["code", "--wait", mockConfigPath]),
            })
        );

        if (originalEditor) {
            process.env.EDITOR = originalEditor;
        } else {
            delete process.env.EDITOR;
        }
    });
});
