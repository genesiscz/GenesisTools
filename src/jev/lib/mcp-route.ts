import type { Evaluator } from "@genesiscz/utils/ai/evaluation/service";
import { routeUtterance } from "./route";

export const jevRouteTool = {
    name: "jev_route",
    description: "Suggest tools argv for an utterance. Hosts decide whether to run. Never executes.",
    inputSchema: {
        type: "object",
        required: ["utterance"],
        properties: { utterance: { type: "string" }, srcDir: { type: "string" } },
    },
};

export async function callJevRoute(options: { utterance: string; srcDir: string; evaluate: Evaluator }) {
    const result = await routeUtterance({ ...options, run: false });
    return { ...result, run: false };
}
