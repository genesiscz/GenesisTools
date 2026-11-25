export { isRecord } from "@genesiscz/utils/object";

/** A missing, NaN or Infinite token count is 0, never a value that poisons the arithmetic. */
export function num(value: number | undefined): number {
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
