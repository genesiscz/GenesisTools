import { DETECTORS } from "./detectors";
import { maskSecret } from "./mask";
import type { Finding, ScanConfig } from "./types";

const INLINE_IGNORE = "secret-scan:ignore";
const PREVIEW_MAX = 80;

interface ScanContentArgs {
    content: string;
    file: string;
    config: ScanConfig;
}

function isAllowlisted(secret: string, line: string, config: ScanConfig): boolean {
    for (const pattern of config.ignorePatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(secret) || pattern.test(line)) {
            return true;
        }
    }

    return false;
}

function buildPreview(line: string, secret: string, masked: string): string {
    const replaced = line.replace(secret, masked).trim();
    if (replaced.length <= PREVIEW_MAX) {
        return replaced;
    }

    return `${replaced.slice(0, PREVIEW_MAX - 1)}…`;
}

/**
 * Pure secret scan over a content string. No fs / clock / env / net access —
 * everything it needs is in `args`. Returns one finding per unique
 * (line, column, masked) span.
 */
export function scanContent({ content, file, config }: ScanContentArgs): Finding[] {
    const findings: Finding[] = [];
    const seen = new Set<string>();
    const lines = content.split("\n");

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        if (line.includes(INLINE_IGNORE)) {
            continue;
        }

        for (const detector of DETECTORS) {
            detector.regex.lastIndex = 0;
            let match = detector.regex.exec(line);

            while (match !== null) {
                const groupIndex = detector.secretGroup ?? 0;
                const secret = match[groupIndex] ?? match[0];
                const column = (groupIndex === 0 ? match.index : line.indexOf(secret, match.index)) + 1;
                const accepted = detector.accept ? detector.accept(secret, config) : true;
                const dedupeKey = `${i + 1}:${column}:${secret}`;

                if (accepted && !seen.has(dedupeKey) && !isAllowlisted(secret, line, config)) {
                    seen.add(dedupeKey);
                    const masked = maskSecret(secret);
                    findings.push({
                        file,
                        line: i + 1,
                        column,
                        detector: detector.name,
                        masked,
                        preview: buildPreview(line, secret, masked),
                    });
                }

                if (detector.regex.lastIndex === match.index) {
                    detector.regex.lastIndex += 1;
                }

                match = detector.regex.exec(line);
            }
        }
    }

    return findings;
}
