import { requireOptionalNativeModule } from "expo";

export type FaceIdGate =
    | { ok: true; via: "biometrics" | "passcode" | "none" | "not-in-build" }
    | { ok: false; reason: string };

/**
 * Asks for Face ID (or Touch ID, or the passcode when biometrics fail) before an act that cannot be undone, such as
 * stopping a session. A phone with no biometrics and no passcode has nothing to ask, so the gate passes with
 * `via: "none"` and the caller's own confirmation is the only check (the simulator answers this way too).
 *
 * The module loads on first use, not at import: expo-router loads every route at start, and a build made before the
 * module was added (no `expo prebuild` since) would otherwise crash at launch. Such a build passes with
 * `via: "not-in-build"`, so the confirmation dialog stays the check until the next native build.
 */
export async function confirmWithFaceId(reason: string): Promise<FaceIdGate> {
    if (!requireOptionalNativeModule("ExpoLocalAuthentication")) {
        console.warn("[face-id] expo-local-authentication is not in this build; run expo prebuild and rebuild");
        return { ok: true, via: "not-in-build" };
    }

    const LocalAuthentication = await import("expo-local-authentication");
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
