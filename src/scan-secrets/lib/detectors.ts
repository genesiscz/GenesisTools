import { shannonEntropy } from "./entropy";
import type { Detector } from "./types";

const ASSIGN = `(?:key|secret|password|passwd|pwd|token|api[_-]?key|access[_-]?key|auth)`;

export const DETECTORS: Detector[] = [
    {
        name: "aws-access-key-id",
        regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    },
    {
        name: "private-key",
        regex: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/g,
    },
    {
        name: "slack-token",
        regex: /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g,
    },
    {
        name: "github-token",
        regex: /\bgh[posr]_[0-9A-Za-z]{36,}\b/g,
    },
    {
        name: "jwt",
        regex: /\beyJ[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\.[0-9A-Za-z_-]{10,}\b/g,
    },
    {
        // identifier containing a secret-ish word, assigned to a quoted string
        name: "generic-assignment",
        regex: new RegExp(`${ASSIGN}["'\`]?\\s*[:=]\\s*["'\`]([^"'\`\\n]{12,})["'\`]`, "gi"),
        secretGroup: 1,
    },
    {
        // assignment to a long base64-ish blob; gated by entropy in `accept`
        name: "high-entropy-base64",
        regex: new RegExp(`${ASSIGN}["'\`]?\\s*[:=]\\s*["'\`]([A-Za-z0-9+/=_-]{20,})["'\`]`, "gi"),
        secretGroup: 1,
        accept: (secret, config) => {
            if (config.disableEntropy) {
                return false;
            }

            return shannonEntropy(secret) >= config.entropyThreshold;
        },
    },
];
