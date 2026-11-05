import { z } from "zod";
import { hostApi, NOTIFICATION_SCHEMAS, SERVICE_PROTOCOL, serviceApi, subscribeParamsSchema } from "./service-protocol";

/**
 * The recorder protocol's schemas as JSON Schema, for the Swift tests: `__fixtures__/service-protocol.schemas.json`.
 * The Swift side checks the answers and notifications its host writes against them, so a field the TypeScript side
 * renames or makes required fails there. `scripts/recorder/write-protocol-fixtures.ts` writes the file and
 * `service.test.ts` fails when it is not what this function makes.
 */

type JsonSchema = Record<string, unknown>;

/**
 * One object schema with a property per name, so a schema several methods share (the edit project, the ops) is
 * written once under `$defs` and named by `$ref`.
 */
function document(schemas: Record<string, z.ZodType>, io: "input" | "output"): JsonSchema {
    const { $schema: _dialect, ...rest } = z.toJSONSchema(z.object(schemas), {
        io,
        unrepresentable: "any",
        reused: "ref",
    });
    return rest;
}

export interface ProtocolSchemas {
    about: string;
    protocol: number;
    /** `properties.<method>`: the params a caller may send (a default makes a field optional). */
    params: JsonSchema;
    /** `properties.<method>`: the result the answering side writes. */
    results: JsonSchema;
    /** `properties.<notification>`: its params. */
    notifications: JsonSchema;
}

export function protocolJsonSchemas(): ProtocolSchemas {
    const params: Record<string, z.ZodType> = { subscribe: subscribeParamsSchema };
    const results: Record<string, z.ZodType> = { subscribe: z.object({ events: z.array(z.string()) }) };

    for (const method of [...serviceApi.methods, ...hostApi.methods]) {
        params[method.name] = method.params;
        results[method.name] = method.result;
    }

    return {
        about: "JSON Schema of every recorder service method (params as sent, result as answered) and notification, made from the zod schemas in src/recorder/lib/service-protocol.ts by scripts/recorder/write-protocol-fixtures.ts. The Swift tests check the host's answers against it.",
        protocol: SERVICE_PROTOCOL,
        params: document(params, "input"),
        results: document(results, "output"),
        notifications: document({ ...NOTIFICATION_SCHEMAS }, "output"),
    };
}
