export type WifiSecurity = "WPA" | "WEP" | "nopass";

export interface WifiPayloadInput {
    ssid: string;
    password?: string;
    security: WifiSecurity;
    hidden: boolean;
}

const CANONICAL_SECURITY: Record<string, WifiSecurity> = {
    wpa: "WPA",
    wep: "WEP",
    nopass: "nopass",
};

/**
 * Normalize a user-supplied security value to the canonical WIFI casing.
 * Accepts case-insensitive input; throws on anything outside WPA|WEP|nopass.
 */
export function normalizeSecurity(value: string): WifiSecurity {
    const canonical = CANONICAL_SECURITY[value.toLowerCase()];
    if (!canonical) {
        throw new Error(`Invalid --security "${value}". Must be one of: WPA, WEP, nopass.`);
    }

    return canonical;
}

/**
 * Escape the five MECARD-reserved characters in a WIFI field by prefixing
 * each with a backslash: \ ; , : "
 * The backslash itself is escaped FIRST so already-present backslashes are
 * not double-processed by the later replacements.
 */
export function escapeWifiField(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/:/g, "\\:")
        .replace(/"/g, '\\"');
}

/**
 * Build a standard WIFI:...;; payload with correctly-escaped SSID/password.
 * Shape: WIFI:T:<security>;S:<ssid>;P:<password>;H:<hidden>;;
 * For security "nopass", P: is emitted empty and password is ignored.
 */
export function buildWifiPayload(input: WifiPayloadInput): string {
    const ssid = escapeWifiField(input.ssid);
    const password = input.security === "nopass" ? "" : escapeWifiField(input.password ?? "");
    const hidden = input.hidden ? "true" : "false";

    return `WIFI:T:${input.security};S:${ssid};P:${password};H:${hidden};;`;
}

/**
 * URL/text passthrough — the input is returned verbatim, no transformation
 * and no auto-prefixing of a scheme.
 */
export function buildTextPayload(text: string): string {
    return text;
}
