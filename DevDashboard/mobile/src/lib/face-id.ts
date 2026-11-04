import * as LocalAuthentication from "expo-local-authentication";

export type FaceIdGate = { ok: true; via: "biometrics" | "passcode" | "none" } | { ok: false; reason: string };

/**
 * Asks for Face ID (or Touch ID, or the passcode when biometrics fail) before an act that cannot be undone, such as
 * stopping a session. A phone with no biometrics and no passcode has nothing to ask, so the gate passes with
 * `via: "none"` and the caller's own confirmation is the only check (the simulator answers this way too).
 */
export async function confirmWithFaceId(reason: string): Promise<FaceIdGate> {
    const level = await LocalAuthentication.getEnrolledLevelAsync();

    if (level === LocalAuthentication.SecurityLevel.NONE) {
        return { ok: true, via: "none" };
    }

    const result = await LocalAuthentication.authenticateAsync({
        promptMessage: reason,
        cancelLabel: "Cancel",
        disableDeviceFallback: false,
    });

    if (result.success) {
        return { ok: true, via: level === LocalAuthentication.SecurityLevel.SECRET ? "passcode" : "biometrics" };
    }

    return { ok: false, reason: result.error === "user_cancel" ? "Cancelled." : `Not confirmed (${result.error}).` };
}
