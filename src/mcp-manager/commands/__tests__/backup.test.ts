import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import logger from "@app/logger";
import { backupAllConfigs } from "@app/mcp-manager/commands/backup.js";
import * as backupUtils from "@app/mcp-manager/utils/backup.js";
import * as configUtils from "@app/mcp-manager/utils/config.utils.js";
import * as fs from "node:fs";
import { MockMCPProvider } from "./test-utils.js";

describe("backupAllConfigs", () => {
    let mockProvider: MockMCPProvider;
    let mockProvider2: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
    });

    it("should backup all provider configs", async () => {
        const mockBackupPath = "/mock/backup/claude.json.backup";

        spyOn(fs, "existsSync").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue(mockBackupPath);
        spyOn(logger, "info");
        spyOn(logger, "debug");

        await backupAllConfigs([mockProvider, mockProvider2]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Backed up"));
    });

    it("should skip providers without config files", async () => {
        mockProvider.configExistsResult = false;

        spyOn(fs, "existsSync").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue("/mock/backup.json");
        spyOn(logger, "info");
        spyOn(logger, "debug");

        await backupAllConfigs([mockProvider, mockProvider2]);

        expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Skipping claude"));
    });

    it("should warn if no configs found to backup", async () => {
        mockProvider.configExistsResult = false;
        mockProvider2.configExistsResult = false;

        spyOn(fs, "existsSync").mockReturnValue(false);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(logger, "warn");

        await backupAllConfigs([mockProvider, mockProvider2]);

        expect(logger.warn).toHaveBeenCalledWith("No configs found to backup.");
    });

    it("should backup unified config if it exists", async () => {
        const mockBackupPath = "/mock/backup/unified.json.backup";

        spyOn(fs, "existsSync").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue(mockBackupPath);
        spyOn(logger, "info");

        await backupAllConfigs([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Backed up unified config"));
    });

    it("should create backup summary", async () => {
        const mockBackupPath = "/mock/backup/claude.json.backup";

        spyOn(fs, "existsSync").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue(mockBackupPath);
        spyOn(logger, "info");

        await backupAllConfigs([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Backup Summary"));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Successfully backed up"));
    });
});
