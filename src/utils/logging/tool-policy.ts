import type pino from "pino";

/**
 * Per-tool console floor: the minimum level promoted to the console when the
 * user passes no -v. Tools whose stdout is a machine result (or that are
 * noisy by nature) raise their floor so diagnostics stay file-only unless
 * explicitly requested. Absent ⇒ "info" (the global default).
 */
const FLOORS: Record<string, pino.Level> = {
    claude: "warn",
};

export function consoleFloorFor(tool: string): pino.Level {
    return FLOORS[tool] ?? "info";
}
