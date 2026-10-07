import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiosError, type InternalAxiosRequestConfig } from "axios";
import {
    applyTlsAcceptFlag,
    certificateErrorMessage,
    createClient,
    isCertificateError,
    loadTrustedPems,
    TLS_ACCEPT_FLAG,
    tlsAcceptUnauthorized,
} from "./client";

const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "jenkins-pems-"));
    dirs.push(dir);

    return dir;
}

afterAll(() => {
    for (const dir of dirs) {
        rmSync(dir, { recursive: true, force: true });
    }
});

describe("loadTrustedPems", () => {
    it("reads every .pem file in name order and ignores other files", () => {
        const dir = tempDir();
        writeFileSync(join(dir, "b-root.pem"), "ROOT");
        writeFileSync(join(dir, "a-intermediate.PEM"), "INTERMEDIATE");
        writeFileSync(join(dir, "notes.txt"), "not a certificate");
        mkdirSync(join(dir, "nested.pem"));

        expect(loadTrustedPems(dir)).toEqual(["INTERMEDIATE", "ROOT"]);
    });

    it("returns nothing for a folder with no .pem file and for a folder that does not exist", () => {
        expect(loadTrustedPems(tempDir())).toEqual([]);
        expect(loadTrustedPems(join(tmpdir(), "jenkins-pems-missing", crypto.randomUUID()))).toEqual([]);
    });
});

describe("tlsAcceptUnauthorized", () => {
    it("is on only for 1, true or yes", () => {
        expect(tlsAcceptUnauthorized({ JENKINS_TLS_ACCEPT_UNAUTHORIZED: "1" })).toBe(true);
        expect(tlsAcceptUnauthorized({ JENKINS_TLS_ACCEPT_UNAUTHORIZED: "TRUE" })).toBe(true);
        expect(tlsAcceptUnauthorized({ JENKINS_TLS_ACCEPT_UNAUTHORIZED: "0" })).toBe(false);
        expect(tlsAcceptUnauthorized({ JENKINS_TLS_ACCEPT_UNAUTHORIZED: "" })).toBe(false);
        expect(tlsAcceptUnauthorized({})).toBe(false);
    });
});

describe("certificate errors", () => {
    it("recognises the failures bun reports and ignores other network errors", () => {
        expect(isCertificateError({ code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE" })).toBe(true);
        expect(isCertificateError({ code: "DEPTH_ZERO_SELF_SIGNED_CERT" })).toBe(true);
        expect(isCertificateError(new Error("unable to verify the first certificate"))).toBe(true);
        expect(isCertificateError({ code: "ECONNREFUSED" })).toBe(false);
        expect(isCertificateError(null)).toBe(false);
    });

    it("fails at once with a message that offers the env switch", async () => {
        const client = createClient({ url: "https://invalid", user: "u", token: "t" });
        let calls = 0;
        client.defaults.adapter = async (config: InternalAxiosRequestConfig) => {
            calls++;
            throw new AxiosError("unable to verify the first certificate", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", config);
        };

        const error = await client.get("/api/json").catch((e: unknown) => e);

        expect(calls).toBe(1);
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(
            certificateErrorMessage("https://invalid", new Error("unable to verify the first certificate"))
        );
        expect((error as Error).message).toContain("JENKINS_TLS_ACCEPT_UNAUTHORIZED=1");
        expect((error as Error).message).toContain(TLS_ACCEPT_FLAG);
    });
});

describe("applyTlsAcceptFlag", () => {
    it("strips the flag anywhere on the line and sets the env switch", () => {
        const env: Record<string, string | undefined> = {};

        expect(applyTlsAcceptFlag(["jobs", TLS_ACCEPT_FLAG, "--folder", "x"], env)).toEqual(["jobs", "--folder", "x"]);
        expect(env.JENKINS_TLS_ACCEPT_UNAUTHORIZED).toBe("1");
    });

    it("leaves argv and env alone without the flag", () => {
        const env: Record<string, string | undefined> = {};
        const argv = ["jobs"];

        expect(applyTlsAcceptFlag(argv, env)).toBe(argv);
        expect(env.JENKINS_TLS_ACCEPT_UNAUTHORIZED).toBeUndefined();
    });
});
