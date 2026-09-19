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

function toWiqlList(csv: string): string | null {
    const values = csv
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

    if (values.length === 0) {
        return null;
    }

    return values.map((v) => `'${escapeWiqlValue(v)}'`).join(", ");
}

// ============= Query Options =============

interface CombinedQueryOptions {
    assignedTo?: string;
    currentAssignedTo?: string;
    /** Match currentAssignedTo with CONTAINS; the server rejects EVER CONTAINS on identity fields */
    assigneeContains?: boolean;
    states?: string;
    excludeStates?: string;
    from?: string;
    to?: string;
    workItemTypes?: string;
    isMacro?: boolean;
    allProjects?: boolean;
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
 * - currentAssignedTo: Uses = on the current assignee, or CONTAINS with assigneeContains
 * - states: Uses IN operator (filters by current state)
 * - excludeStates: Uses NOT IN operator (drops items in these current states)
 * - workItemTypes: Uses IN operator (filters by work item type)
 * - from/to: Filters by ChangedDate range
 * - allProjects: Drops the [System.TeamProject] = @project predicate (org-wide search)
 *
 * @param options - Query filter options
 * @returns WIQL query string
 */
export function buildCombinedQuery(options: CombinedQueryOptions): string {
    const conditions: string[] = options.allProjects ? [] : ["[System.TeamProject] = @project"];

    if (options.assignedTo) {
        const val = options.isMacro ? options.assignedTo : `'${escapeWiqlValue(options.assignedTo)}'`;
        conditions.push(`EVER [System.AssignedTo] = ${val}`);
    }

    if (options.currentAssignedTo) {
        const val = options.isMacro ? options.currentAssignedTo : `'${escapeWiqlValue(options.currentAssignedTo)}'`;
        const operator = options.assigneeContains && !options.isMacro ? "CONTAINS" : "=";
        conditions.push(`[System.AssignedTo] ${operator} ${val}`);
    }

    const states = options.states ? toWiqlList(options.states) : null;
    if (states) {
        conditions.push(`[System.State] IN (${states})`);
    }

    const excludeStates = options.excludeStates ? toWiqlList(options.excludeStates) : null;
    if (excludeStates) {
        conditions.push(`[System.State] NOT IN (${excludeStates})`);
    }

    const workItemTypes = options.workItemTypes ? toWiqlList(options.workItemTypes) : null;
    if (workItemTypes) {
        conditions.push(`[System.WorkItemType] IN (${workItemTypes})`);
    }

    if (options.from) {
        conditions.push(`[System.ChangedDate] >= '${escapeWiqlValue(options.from)}'`);
    }

    if (options.to) {
        conditions.push(`[System.ChangedDate] <= '${escapeWiqlValue(options.to)}'`);
    }

    if (conditions.length === 0) {
        conditions.push("[System.Id] > 0");
    }

    return [
        `SELECT ${STANDARD_SELECT_FIELDS}`,
        "FROM workitems",
        `WHERE ${conditions.join("\n  AND ")}`,
        "ORDER BY [System.ChangedDate] DESC",
    ].join("\n");
}
