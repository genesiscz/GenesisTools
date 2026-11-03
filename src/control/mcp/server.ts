import { toMcpTools } from "@genesiscz/utils/api-descriptor";
import { SafeJSON } from "@genesiscz/utils/json";
import { logger } from "@genesiscz/utils/logger";
import { serveStdio } from "@genesiscz/utils/mcp/stdio";
import {
    type CallToolResult,
    type ListToolsResult,
    ProtocolError,
    ProtocolErrorCode,
    Server,
} from "@modelcontextprotocol/server";
import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { computerApi } from "../lib/computer-use/descriptor";
import { type ComputerMethod, computerSchemas } from "../lib/computer-use/schemas";
import { ComputerUse, ComputerUseError } from "../lib/computer-use/session";

export async function invokeComputerTool(options: {
    computer: ComputerUse;
    name: ComputerMethod;
    input: unknown;
    signal?: AbortSignal;
}): Promise<unknown> {
    const { computer, name, input, signal } = options;
    switch (name) {
        case "assist_task":
            return computer.assist_task({ ...computerSchemas.assist_task.parse(input), signal });
        case "run_workflow":
            return computer.run_workflow({ ...computerSchemas.run_workflow.parse(input), signal });
        case "fill_form":
            return computer.fill_form({ ...computerSchemas.fill_form.parse(input), signal });
        case "press_sequence":
            return computer.press_sequence({ ...computerSchemas.press_sequence.parse(input), signal });
        case "await_condition":
            return computer.await_condition({ ...computerSchemas.await_condition.parse(input), signal });
        case "get_app_state":
            return computer.get_app_state({ ...computerSchemas.get_app_state.parse(input), signal });
        case "get_menu":
            return computer.get_menu({ ...computerSchemas.get_menu.parse(input), signal });
        case "perform_menu_action":
            return computer.perform_menu_action({ ...computerSchemas.perform_menu_action.parse(input), signal });
        case "list_windows":
            return computer.list_windows({ ...computerSchemas.list_windows.parse(input), signal });
        case "list_apps":
            return computer.list_apps({ ...computerSchemas.list_apps.parse(input), signal });
        case "launch_app":
            return computer.launch_app({ ...computerSchemas.launch_app.parse(input), signal });
        case "quit_app":
            return computer.quit_app({ ...computerSchemas.quit_app.parse(input), signal });
        case "click":
            return computer.click({ ...computerSchemas.click.parse(input), signal });
        case "drag":
            return computer.drag({ ...computerSchemas.drag.parse(input), signal });
        case "scroll":
            return computer.scroll({ ...computerSchemas.scroll.parse(input), signal });
        case "set_value":
            return computer.set_value({ ...computerSchemas.set_value.parse(input), signal });
        case "select_text":
            return computer.select_text({ ...computerSchemas.select_text.parse(input), signal });
        case "perform_secondary_action":
            return computer.perform_secondary_action({
                ...computerSchemas.perform_secondary_action.parse(input),
                signal,
            });
        case "paste":
            return computer.paste({ ...computerSchemas.paste.parse(input), signal });
        case "type_text":
            return computer.type_text({ ...computerSchemas.type_text.parse(input), signal });
        case "press_key":
            return computer.press_key({ ...computerSchemas.press_key.parse(input), signal });
        case "focus":
            return computer.focus({ ...computerSchemas.focus.parse(input), signal });
        case "get_elements":
            return computer.get_elements({ ...computerSchemas.get_elements.parse(input), signal });
        case "find":
            return computer.find({ ...computerSchemas.find.parse(input), signal });
        case "resolve_visual_target":
            return computer.resolve_visual_target({ ...computerSchemas.resolve_visual_target.parse(input), signal });
        case "resolve_target":
            return computer.resolve_target({ ...computerSchemas.resolve_target.parse(input), signal });
        case "verify_state":
            return computer.verify_state({ ...computerSchemas.verify_state.parse(input), signal });
        case "close_session":
            return computer.close_session({ ...computerSchemas.close_session.parse(input), signal });
    }
}
export function createComputerMcpServer(options: { computer?: ComputerUse } = {}): Server {
    const computer = options.computer ?? new ComputerUse();
    const server = new Server({ name: "genesis-computer-use", version: "1.0.0" }, { capabilities: { tools: {} } });
    // Built once: the descriptor is a module constant, so re-deriving 27 JSON Schemas per `tools/list` buys nothing.
    const tools = toMcpTools(computerApi) as ListToolsResult["tools"];
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const name = request.params.name;
        if (!Object.hasOwn(computerSchemas, name)) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        try {
            const result = await invokeComputerTool({
                computer,
                name: name as ComputerMethod,
                input: request.params.arguments ?? {},
                signal: context.mcpReq.signal,
            });
            const text = SafeJSON.stringify(result);
            const content: CallToolResult["content"] = [{ type: "text", text }];
            if (name === "get_app_state") {
                const input = computerSchemas.get_app_state.parse(request.params.arguments);
                if (input.image) {
                    const bytes = await computer.read_image(input.app);
                    content.push({ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/png" });
                }
            }
            const failed = result !== null && typeof result === "object" && "ok" in result && result.ok === false;
            return { content, isError: failed };
        } catch (error) {
            logger.debug({ error, tool: name }, "Computer Use request stopped");
            return {
                content: [
                    {
                        type: "text",
                        text: SafeJSON.stringify({
                            error: error instanceof Error ? error.message : "Native operation failed.",
                            code: error instanceof ComputerUseError ? error.code : "REQUEST_FAILED",
                            ...(error instanceof ComputerUseError && error.details ? { details: error.details } : {}),
                        }),
                    },
                ],
                isError: true,
            };
        }
    });
    server.onclose = () => {
        try {
            computer.close_session();
        } catch (error) {
            logger.debug({ error }, "Native request was still ending when MCP closed");
        }
    };
    return server;
}
export async function startComputerMcpServer(): Promise<void> {
    const server = createComputerMcpServer();
    await serveStdio({
        name: "computer-use",
        server,
        transport: new StdioServerTransport(),
        shutdown: () => server.close(),
    });
}
