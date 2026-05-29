import { randomUUID } from "node:crypto";

export function makeStandaloneTmuxSessionName(prefix = "cmux"): string {
    return `${prefix}-${randomUUID().slice(0, 8)}`;
}
