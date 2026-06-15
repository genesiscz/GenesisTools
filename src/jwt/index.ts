import { logger, out } from "@app/logger";
import { isInteractive, runTool, suggestCommand } from "@app/utils/cli";
import { SafeJSON } from "@app/utils/json";
import { Command } from "commander";
import { decodeJwt, describeClaimTime, type JwtObject, type TimeClaim } from "./lib/jwt-core";

const TIME_CLAIMS: TimeClaim[] = ["exp", "iat", "nbf"];

function pad(value: number, width = 2): string {
    return String(value).padStart(width, "0");
}

// Local YYYY-MM-DD HH:MM:SS — matches the spec's example output. `formatTimestamp`
// from @app/utils/format is time-only (HH:MM:SS.mmm), which drops the date.
function formatLocalDateTime(date: Date): string {
    const ymd = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const hms = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
    return `${ymd} ${hms}`;
}

function renderValue(value: unknown): string {
    if (typeof value === "string") {
        return value;
    }

    if (typeof value === "number" || typeof value === "boolean" || value === null) {
        return String(value);
    }

    return SafeJSON.stringify(value);
}

function describeIfTimeClaim(key: string, value: unknown, nowMs: number): string | null {
    if (!TIME_CLAIMS.includes(key as TimeClaim) || typeof value !== "number" || !Number.isFinite(value)) {
        return null;
    }

    const claim = key as TimeClaim;
    const verb = claim === "exp" ? "expires" : claim === "iat" ? "issued" : "valid from";
    const local = formatLocalDateTime(new Date(value * 1000));
    return `${verb} ${local} — ${describeClaimTime(claim, value, nowMs)}`;
}

function printHumanized(header: JwtObject, payload: JwtObject, nowMs: number): void {
    out.println("Header");
    out.println(`  alg  ${renderValue(header.alg ?? "(none)")}`);
    out.println(`  typ  ${renderValue(header.typ ?? "(none)")}`);
    out.println("");
    out.println("Claims");

    for (const [key, value] of Object.entries(payload)) {
        const annotation = describeIfTimeClaim(key, value, nowMs);
        const base = `  ${key}  ${renderValue(value)}`;
        out.println(annotation ? `${base}   (${annotation})` : base);
    }

    out.println("");
    out.println("Signature  not verified (offline decode only)");
}

async function readToken(argToken: string | undefined): Promise<string | undefined> {
    if (argToken && argToken.trim().length > 0) {
        return argToken.trim();
    }

    if (isInteractive()) {
        return undefined;
    }

    const piped = (await Bun.stdin.text()).trim();
    return piped.length > 0 ? piped : undefined;
}

async function main(): Promise<void> {
    const program = new Command()
        .name("jwt")
        .description(
            "Decode & inspect a JWT (offline). Base64url-decodes the header and payload and humanizes " +
                "exp/iat/nbf into local + relative time. Offline; does not verify signatures."
        )
        .argument("[token]", "JWT to decode (omit to read from stdin)")
        .option("--json", "Print raw decoded { header, payload } as pretty JSON")
        .option("-v, --verbose", "Verbose diagnostics on stderr (never includes the token)");

    await runTool(program, { tool: "jwt" });

    const options = program.opts<{ json?: boolean; verbose?: boolean }>();
    const token = await readToken(program.args[0]);

    if (!token) {
        out.error("Error: no token provided.");
        out.error(suggestCommand("tools jwt", { add: ["<token>"] }));
        out.error('Or pipe one:  echo "<token>" | tools jwt');
        await out.flush();
        process.exit(1);
    }

    const result = decodeJwt(token);

    if (!result.ok) {
        out.error(`Error: ${result.error}`);
        await out.flush();
        process.exit(1);
    }

    // Diagnostics only — NEVER the token or claim values (Requirement 9).
    logger.debug({ alg: renderValue(result.header.alg ?? "none"), segments: 3 }, "jwt decoded");

    if (options.json) {
        out.result(SafeJSON.stringify({ header: result.header, payload: result.payload }, null, 2));
        return;
    }

    printHumanized(result.header, result.payload, Date.now());
}

main().catch(async (error) => {
    out.error(`Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    await out.flush();
    process.exit(1);
});
