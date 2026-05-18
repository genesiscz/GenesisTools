#!/usr/bin/env bun
/**
 * UI palette guardrail — fails CI if app UI code uses raw Tailwind palette
 * instead of theme tokens. Enforces the contract in
 * `.claude/docs/design-system.md` so clarity/shops/reas can't drift "flat"
 * again. Run: `bun scripts/check-ui-palette.ts` (or `bun run check:ui-palette`).
 *
 * - HARD FAIL: zinc / neutral / white-opacity surfaces & text (the flatness
 *   pathology that bypasses the design system).
 * - WARN only: gray / slate (same pathology, ~675 pre-existing occurrences —
 *   tracked follow-up; new code should still avoid them).
 * - Exempt: any line tagged `allow-palette` (self-documenting semantic
 *   carve-outs like categorical status colors) or `scrim` / `overlay`
 *   (intentional media/gradient scrims).
 */
import { $ } from "bun";

const SCOPE = ["src/clarity/ui", "src/shops/ui", "src/Internal/commands/reas/ui", "src/dev-dashboard/ui/src"];

const HARD = "bg-zinc-|border-zinc-|text-zinc-|bg-neutral-|border-neutral-|text-neutral-|border-white/|bg-white/[0-9]";
const WARN = "text-gray-|bg-gray-|border-gray-|text-slate-|bg-slate-|border-slate-";

const EXEMPT = /allow-palette|scrim|overlay/;

async function scan(pattern: string): Promise<string[]> {
    const raw = await $`rg -n ${pattern} ${SCOPE}`.nothrow().text();
    return raw.split("\n").filter((line) => line.trim().length > 0 && !EXEMPT.test(line));
}

const hardHits = await scan(HARD);
const warnHits = await scan(WARN);

if (warnHits.length > 0) {
    console.warn(
        `⚠ ${warnHits.length} gray/slate utilities (tracked follow-up — prefer text-muted-foreground/foreground/bg-card; see design-system.md)`
    );
}

if (hardHits.length > 0) {
    console.error(
        `✖ ${hardHits.length} raw zinc/neutral/white-opacity utilities found — use theme tokens (bg-card, border-border, text-muted-foreground, …). See .claude/docs/design-system.md. Tag a deliberate semantic carve-out with an \`allow-palette\` comment.`
    );
    console.error(hardHits.join("\n"));
    process.exit(1);
}

console.log(`✓ no raw zinc/neutral/white-opacity palette under src/**/ui (${warnHits.length} gray/slate warnings)`);
