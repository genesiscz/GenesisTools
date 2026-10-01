import { extensionChecks } from "@app/browser-extension/lib/host/loaded";
import { Analyzer } from "@app/doctor/lib/analyzer";
import type { AnalyzerCategory, AnalyzerContext, Finding } from "@app/doctor/lib/types";

/** The GenesisTools browser extensions: built, loaded, current, and able to reach their native host. */
export class ExtensionsAnalyzer extends Analyzer {
    readonly id = "extensions";
    readonly name = "Browser extensions";
    readonly icon = "E";
    readonly category: AnalyzerCategory = "system";

    protected async *run(_ctx: AnalyzerContext): AsyncIterable<Finding> {
        for (const [index, check] of extensionChecks().entries()) {
            yield {
                id: `extensions-${index}`,
                analyzerId: this.id,
                title: check.message,
                detail: check.fix.length === 0 ? undefined : check.fix.join("\n"),
                severity: check.ok ? "safe" : "cautious",
                actions: [],
                metadata: { extension: check.extension, ok: check.ok },
            };
        }
    }
}
