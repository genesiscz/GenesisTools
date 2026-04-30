import type { ColumnType, Generated } from "kysely";

export interface UsageRecordsTable {
    id: Generated<number>;
    session_id: string;
    provider: string;
    model: string;
    input_tokens: ColumnType<number, number | undefined, number>;
    output_tokens: ColumnType<number, number | undefined, number>;
    cached_input_tokens: ColumnType<number, number | undefined, number>;
    total_tokens: ColumnType<number, number | undefined, number>;
    cost: ColumnType<number, number | undefined, number>;
    timestamp: string;
    message_index: number | null;
    created_at: Generated<string>;
}

export interface AskDB {
    usage_records: UsageRecordsTable;
}
