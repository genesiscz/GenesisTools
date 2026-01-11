import { describe, it, expect, beforeEach, spyOn } from "bun:test";
import { backupAllConfigs } from "../backup.js";
import { MockMCPProvider } from "./test-utils.js";
import * as configUtils from "../../utils/config.utils.js";
import * as backupUtils from "../../utils/backup.js";
import { existsSync } from "fs";
import logger from "@app/logger";

describe("backupAllConfigs", () => {
    let mockProvider: MockMCPProvider;
    let mockProvider2: MockMCPProvider;

    beforeEach(() => {
        mockProvider = new MockMCPProvider("claude", "/mock/claude.json");
        mockProvider2 = new MockMCPProvider("gemini", "/mock/gemini.json");
    });

    it("should backup all provider configs", async () => {
        const mockBackupPath = "/mock/backup/claude.json.backup";
        
        spyOn(existsSync as any, "mock").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue(mockBackupPath);
        spyOn(logger, "info");
        spyOn(logger, "debug");

        await backupAllConfigs([mockProvider, mockProvider2]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Backed up"));
    });

    it("should skip providers without config files", async () => {
        mockProvider.configExistsResult = false;
        
        spyOn(existsSync as any, "mock").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue("/mock/backup.json");
        spyOn(logger, "info");
        spyOn(logger, "debug");

        await backupAllConfigs([mockProvider, mockProvider2]);

        expect(logger.debug).toHaveBeenCalledWith(
            expect.stringContaining("Skipping claude")
        );
    });

    it("should warn if no configs found to backup", async () => {
        mockProvider.configExistsResult = false;
        mockProvider2.configExistsResult = false;
        
        spyOn(existsSync as any, "mock").mockReturnValue(false);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(logger, "warn");

        await backupAllConfigs([mockProvider, mockProvider2]);

        expect(logger.warn).toHaveBeenCalledWith("No configs found to backup.");
    });

    it("should backup unified config if it exists", async () => {
        const mockBackupPath = "/mock/backup/unified.json.backup";
        
        spyOn(existsSync as any, "mock").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue(mockBackupPath);
        spyOn(logger, "info");

        await backupAllConfigs([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Backed up unified config"));
    });

    it("should create backup summary", async () => {
        const mockBackupPath = "/mock/backup/claude.json.backup";
        
        spyOn(existsSync as any, "mock").mockReturnValue(true);
        spyOn(configUtils, "getUnifiedConfigPath").mockReturnValue("/mock/unified.json");
        spyOn(backupUtils.BackupManager.prototype, "createBackup").mockResolvedValue(mockBackupPath);
        spyOn(logger, "info");

        await backupAllConfigs([mockProvider]);

        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Backup Summary"));
        expect(logger.info).toHaveBeenCalledWith(expect.stringContaining("Successfully backed up"));
    });
});




