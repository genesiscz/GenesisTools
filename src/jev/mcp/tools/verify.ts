import { type CustomTemplate, parseCustomTemplates } from "@app/jev/lib/screen/custom";
import { DEFAULT_VERIFY_PURPOSES, listTemplates, parsePurposes } from "@app/jev/lib/screen/templates";
import { parseClaims, verifyClaims } from "@app/jev/lib/screen/verify";
import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { logger } from "@genesiscz/utils/logger";

/**
 * `jev_verify` for the MCP door. Read-only: it scores claims and the document and reports the gate
 * verdict, it never writes a file and never turns a gate into a process exit.
 *
 * The server file is owned by the route package, so this module exports the descriptor and the
 * handler and the server registers them.
 */
export const jevVerifyTool = {
    name: "jev_verify",
    description:
        "Score claims against a document with Jev and run purpose templates over it. Read-only: returns scores and the gate verdict, never edits anything.",
} as const;

export interface JevVerifyArgs {
    claims: string;
    against: string;
    purpose?: string;
    task?: string;
    custom?: string;
    uri?: string;
}

export async function handleJevVerify(args: JevVerifyArgs, deps: { evaluate: Evaluator; signal?: AbortSignal }) {
    const purposes = parsePurposes(args.purpose, DEFAULT_VERIFY_PURPOSES);
    const custom: CustomTemplate[] | undefined = args.custom ? parseCustomTemplates(args.custom) : undefined;
    const claims = parseClaims(args.claims);
    logger.info(
        { door: "mcp", claims: claims.length, purposes: purposes.map((template) => template.id), uri: args.uri },
        "jev_verify called"
    );
    const result = await verifyClaims({
        claims,
        against: args.against,
        purposes,
        custom,
        task: args.task,
        uri: args.uri ?? "mcp",
        evaluate: deps.evaluate,
        signal: deps.signal,
    });
    return {
        purposes: result.purposes,
        document: result.document,
        claims: result.claims,
        gate: result.gate,
        missingAnswers: result.missingAnswers,
    };
}

export const jevVerifyTemplatesTool = {
    name: "jev_verify_templates",
    description: "List the Jev purpose templates and the questions each one asks.",
    inputSchema: { type: "object", properties: {} },
} as const;

export function handleJevVerifyTemplates() {
    return { templates: listTemplates() };
}
