/**
 * WIQL Query Builder
 * Builds WIQL queries programmatically with EVER, ASOF, and date math support.
 * User names must be pre-resolved via resolveUser() before calling these functions.
 */

// ============= Constants =============

const STANDARD_SELECT_FIELDS = [
    "[System.Id]",
    "[System.Title]",
    "[System.State]",
    "[System.AssignedTo]",
    "[System.ChangedDate]",
    "[System.WorkItemType]",
].join(", ");

const ASOF_SELECT_FIELDS = ["[System.Id]", "[System.Title]", "[System.State]", "[System.AssignedTo]"].join(", ");

// ============= Helpers =============

/**
 * Escape a value for use in a WIQL string literal.
 * WIQL uses single quotes for string values, and a single quote inside
 * a value must be doubled (i.e., ' becomes '').
 */
export function escapeWiqlValue(value: string): string {
    return value.replace(/'/g, "''");
}

// ============= Query Options =============

interface CombinedQueryOptions {
    assignedTo?: string;
    currentAssignedTo?: string;
    states?: string;
    from?: string;
    to?: string;
    workItemTypes?: string;
    isMacro?: boolean;
}

// ============= Query Builders =============

/**
 * Build a WIQL query that finds work items EVER assigned to a specific user.
 *
 * Uses the WIQL EVER operator on System.AssignedTo and optionally constrains
 * results by ChangedDate range.
 *
 * @param exactUserName - Pre-resolved display name (e.g., "John Doe")
 * @param from - Optional ISO date string for ChangedDate lower bound
 * @param to - Optional ISO date string for ChangedDate upper bound
 * @returns WIQL query string
 *
 * @note WIQL EVER limitation: The EVER operator checks if a field was EVER set
 * to a value, but cannot constrain WHEN it was set. For "assigned to X between
 * date A and B", we add ChangedDate filter as approximation. For exact
 * date-range assignment tracking, use local history search with downloaded
 * /updates data.
 */
export function buildEverAssignedQuery(exactUserName: string, from?: string, to?: string, isMacro?: boolean): string {
    const userValue = isMacro ? exactUserName : `'${escapeWiqlValue(exactUserName)}'`;
    const conditions: string[] = ["[System.TeamProject] = @project", `EVER [System.AssignedTo] = ${userValue}`];

    if (from) {
        conditions.push(`[System.ChangedDate] >= '${escapeWiqlValue(from)}'`);
    }

    if (to) {
        conditions.push(`[System.ChangedDate] <= '${escapeWiqlValue(to)}'`);
    }

    return [
        `SELECT ${STANDARD_SELECT_FIELDS}`,
        "FROM workitems",
        `WHERE ${conditions.join("\n  AND ")}`,
        "ORDER BY [System.ChangedDate] DESC",
    ].join("\n");
}

/**
 * Build a WIQL query that finds work items that were EVER in one of the given states.
 *
 * States are provided as a comma-separated string. Each state generates an
 * EVER clause, combined with OR inside a group.
 *
 * @param states - Comma-separated state names (e.g., "Active,In Progress")
 * @param from - Optional ISO date string for ChangedDate lower bound
 * @param to - Optional ISO date string for ChangedDate upper bound
 * @returns WIQL query string
 */
export function buildEverInStateQuery(states: string, from?: string, to?: string): string {
    const stateList = states
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    if (stateList.length === 0) {
        throw new Error("At least one state must be provided");
    }

    const everClauses = stateList.map((state) => `EVER [System.State] = '${escapeWiqlValue(state)}'`);

    const stateCondition = stateList.length === 1 ? everClauses[0] : `(${everClauses.join(" OR ")})`;

    const conditions: string[] = ["[System.TeamProject] = @project", stateCondition];

    if (from) {
        conditions.push(`[System.ChangedDate] >= '${escapeWiqlValue(from)}'`);
    }

    if (to) {
        conditions.push(`[System.ChangedDate] <= '${escapeWiqlValue(to)}'`);
    }

    return [
        `SELECT ${STANDARD_SELECT_FIELDS}`,
        "FROM workitems",
        `WHERE ${conditions.join("\n  AND ")}`,
        "ORDER BY [System.ChangedDate] DESC",
    ].join("\n");
}

/**
 * Build a WIQL query with an ASOF clause for point-in-time snapshots.
 *
 * Wraps arbitrary WHERE conditions with the ASOF modifier, which returns
 * work item state as it existed at the given date/time.
 *
 * @param baseConditions - WHERE clause conditions (without the WHERE keyword),
 *   e.g., "[System.State] = 'Active' AND [System.AssignedTo] = 'John Doe'"
 * @param asOfDate - ISO date string for the point-in-time snapshot
 * @returns WIQL query string
 *
 * @note WIQL ASOF queries are read-only point-in-time snapshots. Two-step
 * process: WIQL returns IDs, then GET /workItems?asOf=... retrieves field
 * values. Could be useful for: "What was the sprint board state last Friday?"
 */
export function buildAsOfQuery(baseConditions: string, asOfDate: string): string {
    return [
        `SELECT ${ASOF_SELECT_FIELDS}`,
        "FROM workitems",
        `WHERE [System.TeamProject] = @project`,
        `  AND ${baseConditions}`,
        `ASOF '${escapeWiqlValue(asOfDate)}'`,
    ].join("\n");
}

/**
 * Build a combined WIQL query from multiple optional filter criteria.
 *
 * - assignedTo: Uses EVER operator (finds items ever assigned to user)
 * - states: Uses IN operator (filters by current state)
 * - workItemTypes: Uses IN operator (filters by work item type)
 * - from/to: Filters by ChangedDate range
 *
 * @param options - Query filter options
 * @returns WIQL query string
 */
export function buildCombinedQuery(options: CombinedQueryOptions): string {
    const conditions: string[] = ["[System.TeamProject] = @project"];

    if (options.assignedTo) {
        const val = options.isMacro ? options.assignedTo : `'${escapeWiqlValue(options.assignedTo)}'`;
        conditions.push(`EVER [System.AssignedTo] = ${val}`);
    }

    if (options.currentAssignedTo) {
        const val = options.isMacro ? options.currentAssignedTo : `'${escapeWiqlValue(options.currentAssignedTo)}'`;
        conditions.push(`[System.AssignedTo] = ${val}`);
    }

    if (options.states) {
        const stateList = options.states
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        if (stateList.length > 0) {
            const escaped = stateList.map((s) => `'${escapeWiqlValue(s)}'`).join(", ");
            conditions.push(`[System.State] IN (${escaped})`);
        }
    }

    if (options.workItemTypes) {
        const typeList = options.workItemTypes
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
        if (typeList.length > 0) {
            const escaped = typeList.map((t) => `'${escapeWiqlValue(t)}'`).join(", ");
            conditions.push(`[System.WorkItemType] IN (${escaped})`);
        }
    }

    if (options.from) {
        conditions.push(`[System.ChangedDate] >= '${escapeWiqlValue(options.from)}'`);
    }

    if (options.to) {
        conditions.push(`[System.ChangedDate] <= '${escapeWiqlValue(options.to)}'`);
    }

    return [
        `SELECT ${STANDARD_SELECT_FIELDS}`,
        "FROM workitems",
        `WHERE ${conditions.join("\n  AND ")}`,
        "ORDER BY [System.ChangedDate] DESC",
    ].join("\n");
}
