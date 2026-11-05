import type * as LocalAuthentication from "expo-local-authentication";

export type AuthenticationModule = Pick<typeof LocalAuthentication, "getEnrolledLevelAsync" | "authenticateAsync"> & {
    SecurityLevel: Pick<typeof LocalAuthentication.SecurityLevel, "NONE" | "SECRET">;
};

type AuthenticationLoader = () => Promise<AuthenticationModule | null>;

async function loadAuthentication(): Promise<AuthenticationModule | null> {
    const { requireOptionalNativeModule } = await import("expo");

    if (!requireOptionalNativeModule("ExpoLocalAuthentication")) {
        return null;
    }

    return import("expo-local-authentication");
}

export type FaceIdGate = { ok: true; via: "biometrics" | "passcode" | "none" } | { ok: false; reason: string };

/**
 * Asks for Face ID (or Touch ID, or the passcode when biometrics fail) before an act that cannot be undone, such as
 * stopping a session. A device with no enrolled authentication refuses the action.
 *
 * The module loads on first use, not at import: expo-router loads every route at start, and a build made before the
 * module was added (no `expo prebuild` since) would otherwise crash at launch. Such a build refuses confirmation
 * and asks for a rebuild.
 */
export function createFaceIdGate(load: AuthenticationLoader) {
    return async (reason: string): Promise<FaceIdGate> => {
        const LocalAuthentication = await load();

        if (!LocalAuthentication) {
            return {
                ok: false,
                reason: "Authentication is unavailable in this build. Rebuild the app before confirming this action.",
            };
        }

        const level = await LocalAuthentication.getEnrolledLevelAsync();

        if (level === LocalAuthentication.SecurityLevel.NONE) {
            return { ok: false, reason: "Set up device authentication before confirming this action." };
        }

        const result = await LocalAuthentication.authenticateAsync({
            promptMessage: reason,
            cancelLabel: "Cancel",
            disableDeviceFallback: false,
        });

        if (result.success) {
            return { ok: true, via: level === LocalAuthentication.SecurityLevel.SECRET ? "passcode" : "biometrics" };
        }

        return {
            ok: false,
            reason: result.error === "user_cancel" ? "Cancelled." : `Not confirmed (${result.error}).`,
        };
    };
}

export const confirmWithFaceId = createFaceIdGate(loadAuthentication);
