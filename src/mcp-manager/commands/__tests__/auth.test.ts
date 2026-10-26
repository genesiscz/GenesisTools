import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { logger } from "@genesiscz/utils/logger";
import * as p from "@genesiscz/utils/prompts/p";
import { Storage } from "@genesiscz/utils/storage/storage";
import { setupStorageSandbox } from "@genesiscz/utils/storage/test-sandbox";
import { authClient } from "../auth.ts";

setupStorageSandbox();

describe("auth client redirect validation", () => {
    const stdinWasTty = process.stdin.isTTY;
    const originalExitCode = process.exitCode;

    beforeEach(async () => {
        Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true, writable: true });
        await new Storage("mcp-manager").setConfig({
            mcpServers: { crm: { type: "http", url: "https://mcp.crm.example" } },
        });
    });

    afterEach(() => {
        Object.defineProperty(process.stdin, "isTTY", { value: stdinWasTty, configurable: true, writable: true });
        process.exitCode = originalExitCode;
    });

    test("rejects localhost before asking for a secret", async () => {
        const password = spyOn(p, "password").mockResolvedValue("");
        const error = spyOn(logger, "error").mockImplementation(() => undefined);

        try {
            await authClient("crm", { clientId: "crm-app", redirectUri: "http://localhost:8320/callback" });

            expect(password).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledWith(expect.stringContaining("--redirect-uri must be"));
            expect(process.exitCode).toBe(1);
        } finally {
            password.mockRestore();
            error.mockRestore();
        }
    });

    test("rejects port zero before asking for a secret", async () => {
        const password = spyOn(p, "password").mockResolvedValue("");
        const error = spyOn(logger, "error").mockImplementation(() => undefined);

        try {
            await authClient("crm", { clientId: "crm-app", redirectUri: "http://127.0.0.1:0/callback" });

            expect(password).not.toHaveBeenCalled();
            expect(error).toHaveBeenCalledWith(expect.stringContaining("--redirect-uri must be"));
        } finally {
            password.mockRestore();
            error.mockRestore();
        }
    });

    test("accepts an explicit IPv4 loopback port and path", async () => {
        const password = spyOn(p, "password").mockResolvedValue("");
        const error = spyOn(logger, "error").mockImplementation(() => undefined);

        try {
            await authClient("crm", { clientId: "crm-app", redirectUri: "http://127.0.0.1:9123/cb" });

            expect(password).toHaveBeenCalledTimes(1);
            expect(error).toHaveBeenCalledWith(expect.stringContaining("client secret is empty"));
        } finally {
            password.mockRestore();
            error.mockRestore();
        }
    });
});
