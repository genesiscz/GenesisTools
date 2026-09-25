/** Why a feature refused or failed, as a stable code the extension can show a state for. */
export type FeatureErrorCode = "invalid" | "no-checkout" | "unavailable" | "failed";

export class FeatureError extends Error {
    constructor(
        readonly code: FeatureErrorCode,
        message: string
    ) {
        super(message);
        this.name = "FeatureError";
    }
}
