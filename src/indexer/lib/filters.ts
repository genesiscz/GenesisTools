const COL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCALAR_OPS = new Set(["=", "!=", "<", "<=", ">", ">=", "LIKE"]);

export interface MetadataFilter {
    column: string;
    op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "LIKE" | "BETWEEN" | "IN";
    value: number | string | Array<number | string> | [number | string, number | string];
}

function assertColumn(name: string): void {
    if (!COL_RE.test(name)) {
        throw new Error(`Invalid column name: "${name}"`);
    }
}

/**
 * Build a SQL predicate for typed metadata columns. Returns
 * { sql: "", params: [] } when filters is empty.
 *
 * Output assumes the indexer's content table is aliased `c` (matching the
 * convention in bm25Search/cosineSearch).
 */
export function buildMetadataPredicate(
    _tableName: string,
    filters: MetadataFilter[]
): { sql: string; params: Array<string | number> } {
    if (filters.length === 0) {
        return { sql: "", params: [] };
    }

    const parts: string[] = [];
    const params: Array<string | number> = [];

    for (const f of filters) {
        assertColumn(f.column);

        if (SCALAR_OPS.has(f.op)) {
            if (Array.isArray(f.value)) {
                throw new Error(`Op "${f.op}" requires a scalar value, got array.`);
            }

            parts.push(`c.${f.column} ${f.op} ?`);
            params.push(f.value);
            continue;
        }

        if (f.op === "BETWEEN") {
            if (!Array.isArray(f.value) || f.value.length !== 2) {
                throw new Error("Op BETWEEN requires a [start, end] tuple value.");
            }

            parts.push(`c.${f.column} BETWEEN ? AND ?`);
            params.push(f.value[0], f.value[1]);
            continue;
        }

        if (f.op === "IN") {
            if (!Array.isArray(f.value)) {
                throw new Error("Op IN requires an array value.");
            }

            if (f.value.length === 0) {
                throw new Error("Op IN requires a non-empty array value.");
            }

            const ph = f.value.map(() => "?").join(", ");
            parts.push(`c.${f.column} IN (${ph})`);
            params.push(...f.value);
            continue;
        }

        throw new Error(`Unsupported op: ${f.op}`);
    }

    return { sql: parts.join(" AND "), params };
}
