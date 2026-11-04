import {
    type DashboardClient,
    ENDPOINTS,
    type MemoActionKind,
    type MemoActReceiptDto,
    type MemoDto,
    type MemosDto,
} from "@dd/contract";
import { queryOptions } from "@tanstack/react-query";

export const memosKeys = { list: ["memos", "list"] as const };

export function memosQuery(client: DashboardClient) {
    return queryOptions<MemosDto>({
        queryKey: memosKeys.list,
        queryFn: () => client.call(ENDPOINTS.gatewayMemos, {}),
        refetchInterval: 60_000,
    });
}

export function actOnMemo(
    client: DashboardClient,
    input: { id: string; action: MemoActionKind; sessionKey?: string; idempotencyKey: string }
): Promise<MemoActReceiptDto> {
    const { idempotencyKey, ...body } = input;
    return client.call(ENDPOINTS.memosAct, body, { idempotencyKey });
}

export const ACTION_LABELS: Readonly<Record<MemoActionKind, string>> = {
    reminders: "Add to Reminders",
    note: "Save to today's note",
    agent: "Send to an agent",
};

/** The actions a memo offers: Reminders only with todos, the agent only with a task. */
export function offeredActions(memo: MemoDto): MemoActionKind[] {
    const all: MemoActionKind[] = ["reminders", "note", "agent"];
    return all.filter((action) => (action === "reminders" ? memo.todos.length > 0 : action === "agent" ? memo.agentTask !== null : true));
}
