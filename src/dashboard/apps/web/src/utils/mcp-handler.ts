import { InMemoryTransport } from "@modelcontextprotocol/server";
import type { McpServer, JSONRPCMessage } from "@modelcontextprotocol/server";

export async function handleMcpRequest(request: Request, server: McpServer): Promise<Response> {
    try {
        const jsonRpcRequest = (await request.json()) as JSONRPCMessage;

        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

        let responseData: JSONRPCMessage | null = null;

        clientTransport.onmessage = (message: JSONRPCMessage) => {
            responseData = message;
        };

        await server.connect(serverTransport);

        await clientTransport.start();
        await serverTransport.start();

        await clientTransport.send(jsonRpcRequest);

        await new Promise((resolve) => setTimeout(resolve, 10));

        await clientTransport.close();
        await serverTransport.close();

        return Response.json(responseData, {
            headers: {
                "Content-Type": "application/json",
            },
        });
    } catch (error) {
        console.error("MCP handler error:", error);

        // Return a JSON-RPC error response
        return Response.json(
            {
                jsonrpc: "2.0",
                error: {
                    code: -32603,
                    message: "Internal server error",
                    data: error instanceof Error ? error.message : String(error),
                },
                id: null,
            },
            {
                status: 500,
                headers: {
                    "Content-Type": "application/json",
                },
            }
        );
    }
}
