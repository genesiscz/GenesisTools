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

type ComputerHandler = (options: { computer: ComputerUse; input: unknown; signal?: AbortSignal }) => unknown;

// Typed by the schema table, so a tool listed in computerSchemas without a handler is a compile error,
// not an `undefined` answered as a success.
const computerHandlers: Record<ComputerMethod, ComputerHandler> = {
    assist_task: ({ computer, input, signal }) =>
        computer.assist_task({ ...computerSchemas.assist_task.parse(input), signal }),
    run_workflow: ({ computer, input, signal }) =>
        computer.run_workflow({ ...computerSchemas.run_workflow.parse(input), signal }),
    fill_form: ({ computer, input, signal }) =>
        computer.fill_form({ ...computerSchemas.fill_form.parse(input), signal }),
    press_sequence: ({ computer, input, signal }) =>
        computer.press_sequence({ ...computerSchemas.press_sequence.parse(input), signal }),
    await_condition: ({ computer, input, signal }) =>
        computer.await_condition({ ...computerSchemas.await_condition.parse(input), signal }),
    get_app_state: ({ computer, input, signal }) =>
        computer.get_app_state({ ...computerSchemas.get_app_state.parse(input), signal }),
    get_menu: ({ computer, input, signal }) => computer.get_menu({ ...computerSchemas.get_menu.parse(input), signal }),
    perform_menu_action: ({ computer, input, signal }) =>
        computer.perform_menu_action({ ...computerSchemas.perform_menu_action.parse(input), signal }),
    list_windows: ({ computer, input, signal }) =>
        computer.list_windows({ ...computerSchemas.list_windows.parse(input), signal }),
    list_apps: ({ computer, input, signal }) =>
        computer.list_apps({ ...computerSchemas.list_apps.parse(input), signal }),
    launch_app: ({ computer, input, signal }) =>
        computer.launch_app({ ...computerSchemas.launch_app.parse(input), signal }),
    quit_app: ({ computer, input, signal }) => computer.quit_app({ ...computerSchemas.quit_app.parse(input), signal }),
    click: ({ computer, input, signal }) => computer.click({ ...computerSchemas.click.parse(input), signal }),
    drag: ({ computer, input, signal }) => computer.drag({ ...computerSchemas.drag.parse(input), signal }),
    scroll: ({ computer, input, signal }) => computer.scroll({ ...computerSchemas.scroll.parse(input), signal }),
    set_value: ({ computer, input, signal }) =>
        computer.set_value({ ...computerSchemas.set_value.parse(input), signal }),
    select_text: ({ computer, input, signal }) =>
        computer.select_text({ ...computerSchemas.select_text.parse(input), signal }),
    perform_secondary_action: ({ computer, input, signal }) =>
        computer.perform_secondary_action({ ...computerSchemas.perform_secondary_action.parse(input), signal }),
    paste: ({ computer, input, signal }) => computer.paste({ ...computerSchemas.paste.parse(input), signal }),
    type_text: ({ computer, input, signal }) =>
        computer.type_text({ ...computerSchemas.type_text.parse(input), signal }),
    press_key: ({ computer, input, signal }) =>
        computer.press_key({ ...computerSchemas.press_key.parse(input), signal }),
    focus: ({ computer, input, signal }) => computer.focus({ ...computerSchemas.focus.parse(input), signal }),
    get_elements: ({ computer, input, signal }) =>
        computer.get_elements({ ...computerSchemas.get_elements.parse(input), signal }),
    find: ({ computer, input, signal }) => computer.find({ ...computerSchemas.find.parse(input), signal }),
    resolve_visual_target: ({ computer, input, signal }) =>
        computer.resolve_visual_target({ ...computerSchemas.resolve_visual_target.parse(input), signal }),
    resolve_target: ({ computer, input, signal }) =>
        computer.resolve_target({ ...computerSchemas.resolve_target.parse(input), signal }),
    verify_state: ({ computer, input, signal }) =>
        computer.verify_state({ ...computerSchemas.verify_state.parse(input), signal }),
    close_session: ({ computer, input, signal }) =>
        computer.close_session({ ...computerSchemas.close_session.parse(input), signal }),
};

export function isComputerTool(name: string): name is ComputerMethod {
    return Object.hasOwn(computerHandlers, name);
}

export async function invokeComputerTool(options: {
    computer: ComputerUse;
    name: ComputerMethod;
    input: unknown;
    signal?: AbortSignal;
}): Promise<unknown> {
    const { computer, name, input, signal } = options;
    return computerHandlers[name]({ computer, input, signal });
}

export function createComputerMcpServer(options: { computer?: ComputerUse } = {}): Server {
    const computer = options.computer ?? new ComputerUse();
    const server = new Server({ name: "genesis-computer-use", version: "1.0.0" }, { capabilities: { tools: {} } });
    // Built once: the descriptor is a module constant, so re-deriving 27 JSON Schemas per `tools/list` buys nothing.
    const tools = toMcpTools(computerApi) as ListToolsResult["tools"];
    server.setRequestHandler("tools/list", async (): Promise<ListToolsResult> => ({ tools }));
    server.setRequestHandler("tools/call", async (request, context): Promise<CallToolResult> => {
        const name = request.params.name;
        if (!isComputerTool(name)) {
            throw new ProtocolError(ProtocolErrorCode.MethodNotFound, `Unknown tool: ${name}`);
        }
        try {
            const result = await invokeComputerTool({
                computer,
                name,
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
