import { describe, expect, it } from "bun:test";
import { type AuthenticationModule, createFaceIdGate } from "./face-id";

describe("Face ID gate", () => {
    it("refuses NONE and does not reach the caller's destructive primitive", async () => {
        let mutations = 0;
        let authentications = 0;
        const confirm = createFaceIdGate(async () => ({ SecurityLevel: { NONE: 0, SECRET: 1 }, getEnrolledLevelAsync: async () => 0, authenticateAsync: async () => { authentications++; throw new Error("must not authenticate without enrollment"); } }));
        const gate = await confirm("Stop this session");
        if (gate.ok) { mutations++; throw new Error("destructive primitive must not run"); }
        expect(gate).toEqual({ ok: false, reason: "Set up device authentication before confirming this action." });
        expect(mutations).toBe(0);
        expect(authentications).toBe(0);
    });

    it("loads lazily and refuses a build missing native authentication with a rebuild reason", async () => {
        let loads = 0;
        const confirm = createFaceIdGate(async () => {
            loads++;
            return null;
        });
        expect(loads).toBe(0);
        const result = await confirm("Allow the operation");
        expect(loads).toBe(1);
        expect(result.ok).toBe(false);
        if (!result.ok) {
            expect(result.reason).toContain("Authentication is unavailable in this build");
            expect(result.reason).toContain("Rebuild the app");
        }
    });

    it("authenticates normally with biometrics or the device passcode", async () => {
        for (const level of [1, 3] as const) {
            const prompts: unknown[] = [];
            const auth: AuthenticationModule = {
                SecurityLevel: { NONE: 0, SECRET: 1 },
                getEnrolledLevelAsync: async () => level,
                authenticateAsync: async (options) => {
                    prompts.push(options);
                    return { success: true };
                },
            };
            const confirm = createFaceIdGate(async () => auth);
            expect(await confirm("Stop this session")).toEqual({
                ok: true,
                via: level === 1 ? "passcode" : "biometrics",
            });
            expect(prompts).toEqual([
                { promptMessage: "Stop this session", cancelLabel: "Cancel", disableDeviceFallback: false },
            ]);
        }
    });

    it("refuses a cancelled or failed native authentication", async () => {
        for (const error of ["user_cancel", "authentication_failed"] as const) {
            const confirm = createFaceIdGate(async () => ({
                SecurityLevel: { NONE: 0, SECRET: 1 },
                getEnrolledLevelAsync: async () => 3,
                authenticateAsync: async () => ({ success: false, error }),
            }));
            expect(await confirm("Allow")).toEqual({
                ok: false,
                reason: error === "user_cancel" ? "Cancelled." : "Not confirmed (authentication_failed).",
            });
        }
    });
});
