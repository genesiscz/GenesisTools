import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { type McpTextResult, registerTool } from "./shared";

interface CallToolTextResult {
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
}

/** Register the given tools on a real McpServer and return a Client wired to it in memory. */
async function connectClient(register: (server: McpServer) => void): Promise<Client> {
    const server = new McpServer({ name: "indexer-test", version: "1.0.0" });
    register(server);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "indexer-test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    return client;
}

const searchShape = {
    query: z.string().describe("what to look for"),
    limit: z.number().optional(),
};

describe("indexer registerTool adapter", () => {
    it("advertises the raw shape as an object JSON Schema with the required keys", async () => {
        const client = await connectClient((server) => {
            registerTool(server, "indexer_search", "Search the index", searchShape, async () => ({
                content: [{ type: "text", text: "" }],
            }));
        });

        const { tools } = await client.listTools();
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe("indexer_search");
        expect(tools[0].description).toBe("Search the index");
        expect(tools[0].inputSchema.type).toBe("object");
        expect(Object.keys(tools[0].inputSchema.properties ?? {}).sort()).toEqual(["limit", "query"]);
        expect(tools[0].inputSchema.required).toEqual(["query"]);

        await client.close();
    });

    it("delivers validated arguments to the handler and returns its content", async () => {
        const received: Array<{ query: string; limit?: number }> = [];
        const client = await connectClient((server) => {
            registerTool(server, "indexer_search", "Search the index", searchShape, async (args) => {
                received.push(args);
                return { content: [{ type: "text", text: `hit:${args.query}:${args.limit ?? 0}` }] };
            });
        });

        const result = (await client.callTool({
            name: "indexer_search",
            arguments: { query: "chunker", limit: 5 },
        })) as CallToolTextResult;

        expect(received).toEqual([{ query: "chunker", limit: 5 }]);
        expect(result.isError).toBeUndefined();
        expect(result.content[0].text).toBe("hit:chunker:5");

        await client.close();
    });

    it("rejects arguments that violate the shape without invoking the handler", async () => {
        let invoked = false;
        const client = await connectClient((server) => {
            registerTool(
                server,
                "indexer_search",
                "Search the index",
                searchShape,
                async (): Promise<McpTextResult> => {
                    invoked = true;
                    return { content: [{ type: "text", text: "should not run" }] };
                }
            );
        });

        const result = (await client.callTool({
            name: "indexer_search",
            arguments: { limit: 5 },
        })) as CallToolTextResult;

        expect(invoked).toBe(false);
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("query");

        await client.close();
    });
});
