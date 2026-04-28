import { Analyzer } from "@app/doctor/lib/analyzer";
import { run } from "@app/doctor/lib/run";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";

interface SecurityCheck {
    cmd: string;
    args: string[];
    label: string;
    ok: (out: string) => boolean;
}

export class SecurityAnalyzer extends Analyzer {
    readonly id = "security";
    readonly name = "Security";
    readonly icon = "Q";
    readonly category: AnalyzerCategory = "security";
    readonly cacheTtlMs = 24 * 60 * 60 * 1000;

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        for (const check of securityChecks()) {
            const res = await run(check.cmd, check.args);
            const stdout = res.stdout ?? "";
            const stderr = res.stderr ?? "";
            const passing = res.status === 0 && check.ok(stdout);

            yield {
                id: `sec-${check.cmd}`,
                analyzerId: this.id,
                title: `${check.label}: ${passing ? "enabled" : "disabled"}`,
                detail: stdout.trim() || stderr.trim(),
                severity: passing ? "safe" : "cautious",
                actions: [],
                metadata: { check: check.label, passing },
            };
        }
    }
}

export function isFileVaultEnabled(out: string): boolean {
    return /FileVault is On/i.test(out);
}

export function isGatekeeperEnabled(out: string): boolean {
    return /assessments enabled/i.test(out);
}

export function isSipEnabled(out: string): boolean {
    return /enabled/i.test(out);
}

function securityChecks(): SecurityCheck[] {
    return [
        {
            cmd: "fdesetup",
            args: ["status"],
            label: "FileVault",
            ok: isFileVaultEnabled,
        },
        {
            cmd: "spctl",
            args: ["--status"],
            label: "Gatekeeper",
            ok: isGatekeeperEnabled,
        },
        {
            cmd: "csrutil",
            args: ["status"],
            label: "SIP (System Integrity Protection)",
            ok: isSipEnabled,
        },
    ];
}
