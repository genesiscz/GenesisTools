import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { openConfig } from "../config.js";
import * as configUtils from "../../utils/config.utils.js";
import * as storageUtils from "../../utils/storage/index.js";
import logger from "@app/logger";

describe("openConfig", () => {
    beforeEach(() => {
        // Reset mocks
    });

    it("should create default config if it doesn't exist", async () => {
        const mockConfigPath = "/mock/config.json";
        
        spyOn(storageUtils.Storage.prototype, "ensureDirs").mockResolvedValue();
        spyOn(storageUtils.Storage.prototype, "getConfig").mockResolvedValue(null);
        spyOn(storageUtils.Storage.prototype, "setConfig").mockResolvedValue();
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");
        
        // Mock Bun.spawn
        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => ({
            exited: Promise.resolve({ exitCode: 0 }),
        } as any));

        await openConfig();

        expect(storageUtils.Storage.prototype.setConfig).toHaveBeenCalledWith({
            mcpServers: {},
        });
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Created default config")
        );
    });

    it("should open existing config in editor", async () => {
        const mockConfigPath = "/mock/config.json";
        const mockConfig = { mcpServers: { "test": {} } };
        
        spyOn(storageUtils.Storage.prototype, "ensureDirs").mockResolvedValue();
        spyOn(storageUtils.Storage.prototype, "getConfig").mockResolvedValue(mockConfig);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");
        
        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => ({
            exited: Promise.resolve({ exitCode: 0 }),
        } as any));

        await openConfig();

        expect(mockSpawn).toHaveBeenCalled();
        expect(logger.info).toHaveBeenCalledWith(
            expect.stringContaining("Config file:")
        );
    });

    it("should use EDITOR environment variable", async () => {
        const originalEditor = process.env.EDITOR;
        process.env.EDITOR = "vim";
        
        const mockConfigPath = "/mock/config.json";
        spyOn(storageUtils.Storage.prototype, "ensureDirs").mockResolvedValue();
        spyOn(storageUtils.Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");
        
        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => ({
            exited: Promise.resolve({ exitCode: 0 }),
        } as any));

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
        spyOn(storageUtils.Storage.prototype, "ensureDirs").mockResolvedValue();
        spyOn(storageUtils.Storage.prototype, "getConfig").mockResolvedValue({ mcpServers: {} });
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue(mockConfigPath);
        spyOn(logger, "info");
        
        const mockSpawn = spyOn(Bun, "spawn").mockImplementation(() => ({
            exited: Promise.resolve({ exitCode: 0 }),
        } as any));

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




