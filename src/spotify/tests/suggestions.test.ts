/**
 * Commands the tool suggests must be commands the tool has.
 *
 * When every report moved under `analytics`, the strings that tell a reader what to run next
 * did not move with them. `compat`'s closing verdict kept advising `spotify gift` and
 * `spotify blend`, so the single most likely follow-up to a low compatibility score answered
 * `error: unknown command 'gift'`. Nothing failed at build time and no test noticed, because
 * the suggestion is just prose until somebody types it.
 *
 * This resolves each suggestion against the real command tree, built from the same registrars
 * `index.ts` uses, so a future regrouping breaks here instead of in front of a user.
 */
import { describe, expect, test } from "bun:test";
import { registerAnalytics } from "@app/spotify/commands/analytics";
import { registerCompat } from "@app/spotify/commands/compat";
import { registerLibrary } from "@app/spotify/commands/library";
import { verdict } from "@app/spotify/lib/reports/compat";
import { Command } from "commander";

/** The `analytics` group exactly as `index.ts` assembles it. */
function analyticsGroup(): Command {
    const analytics = new Command("analytics");
    registerAnalytics(analytics);
    registerLibrary(analytics);
    registerCompat(analytics);

    return analytics;
}

function names(group: Command): Set<string> {
    const all = new Set<string>();
    for (const c of group.commands) {
        all.add(c.name());
        for (const alias of c.aliases()) {
            all.add(alias);
        }
    }

    return all;
}

/** Every `` `spotify …` `` reference in a string, minus the leading tool name. */
function suggestionsIn(text: string): string[] {
    return [...text.matchAll(/`spotify ([^`]+)`/g)].map((m) => m[1]!.trim());
}

describe("compat verdict suggestions", () => {
    // One score per band, so a band whose suggestion rots is caught even if the others are fine.
    const scores = [0.9, 0.5, 0.3, 0.15, 0.05];

    test("every band that suggests a command names a real one", () => {
        const known = names(analyticsGroup());
        const checked: string[] = [];

        for (const score of scores) {
            for (const suggestion of suggestionsIn(verdict(score))) {
                const [group, sub] = suggestion.split(/\s+/);
                expect(group).toBe("analytics");
                expect(known).toContain(sub!);
                checked.push(suggestion);
            }
        }

        // Guards the guard: if the verdict text stops carrying suggestions the loop above
        // passes vacuously, which is how a test keeps reporting green over a deleted feature.
        expect(checked.length).toBeGreaterThan(0);
    });

    test("the bare group-less form this regressed to would be rejected", () => {
        const known = names(analyticsGroup());
        expect(known.has("spotify gift")).toBe(false);
        expect(suggestionsIn("try `spotify gift`")).toEqual(["gift"]);
    });
});
