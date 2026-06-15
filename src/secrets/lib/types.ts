export type DetectorName =
    | "aws-access-key-id"
    | "private-key"
    | "slack-token"
    | "github-token"
    | "jwt"
    | "generic-assignment"
    | "high-entropy-base64";

export interface Finding {
    file: string;
    line: number;
    column: number;
    detector: DetectorName;
    masked: string;
    preview: string;
}

export interface ScanConfig {
    /** Allowlist regexes; a finding is dropped if its secret OR line matches any. */
    ignorePatterns: RegExp[];
    /** Disable the high-entropy-base64 detector. */
    disableEntropy: boolean;
    /** Shannon-entropy threshold (bits/char) for the entropy detector. */
    entropyThreshold: number;
    /** Minimum length for generic/entropy candidate secrets. */
    minSecretLength: number;
}

export interface Detector {
    name: DetectorName;
    /** MUST be global (`g`) so we can iterate all matches per line. */
    regex: RegExp;
    /**
     * The capture group index holding the secret text (for masking).
     * 0 = whole match. Defaults to 0.
     */
    secretGroup?: number;
    /** Optional extra accept gate (e.g. entropy). Return false to reject. */
    accept?: (secret: string, config: ScanConfig) => boolean;
}

export interface ScanResultFileSkip {
    file: string;
    reason: "binary" | "too-large" | "read-error";
}

export interface ScanResult {
    scannedFiles: number;
    skippedFiles: number;
    skips: ScanResultFileSkip[];
    findingCount: number;
    findings: Finding[];
    /** ISO timestamp (injected `now`) — keeps JSON output deterministic in tests. */
    scannedAt: string;
}

export function defaultScanConfig(): ScanConfig {
    return {
        ignorePatterns: [],
        disableEntropy: false,
        entropyThreshold: 4.0,
        minSecretLength: 16,
    };
}
