import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { SafeJSON } from "@app/utils/json";

export class JsonlWriter {
    constructor(private readonly path: string) {}

    append(record: Record<string, unknown>): void {
        mkdirSync(dirname(this.path), { recursive: true });
        appendFileSync(this.path, `${SafeJSON.stringify(record, { jsonl: true })}\n`);
    }
}
