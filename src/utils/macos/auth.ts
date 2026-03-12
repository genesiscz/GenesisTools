import { getDarwinKit } from "./darwinkit";
import type { AuthAvailableResult, AuthenticateResult } from "./types";

/**
 * Check if biometric authentication (Touch ID / Optic ID) is available.
 */
export async function checkBiometry(): Promise<AuthAvailableResult> {
    return getDarwinKit().auth.available();
}

/**
 * Authenticate using biometrics (Touch ID / Optic ID).
 * @param reason - Reason string shown in the system prompt
 */
export async function authenticate(reason?: string): Promise<AuthenticateResult> {
    return getDarwinKit().auth.authenticate(reason ? { reason } : undefined);
}
