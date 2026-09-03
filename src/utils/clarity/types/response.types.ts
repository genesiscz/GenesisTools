// -- Top-level response --
export interface TimesheetResponse {
    calendar: CalendarSection;
    timesheets: TimesheetsSection;
    resource: ResourceSection;
    resourcecalendar: ResourceCalendarSection;
    _self: string;
    _metadata: { virtualResource: string };
}

// -- Calendar --
export interface CalendarSection {
    _self: string;
    _results: CalendarDay[];
}

export interface CalendarDay {
    date: string; // ISO "2026-02-09T00:00:00"
    shortForm: string; // "9.2"
    dayOfEmployment: string;
    _self: string;
    workDay: string; // "true" | "false"
    day: string; // "Po" | "Ut" | "St" | "Ct" | "Pa" | "So" | "Ne"
    workTime: number; // 7.5 or 0
    hoursPerDay: number; // 7.5
}

// -- Timesheets --
export interface TimesheetsSection {
    _self: string;
    _results: TimesheetRecord[];
}

export interface TimesheetRecord {
    _internalId: number; // timesheetId (e.g. 8524081)
    resourceId: number;
    isActive: boolean;
    actualsTotal: number;
    timePeriodStart: string; // ISO, first day of the period
    /**
     * ISO, and INCLUSIVE: the last day that belongs to the period. A week running Monday to
     * Sunday reports finish 2026-08-30, not 2026-08-31.
     *
     * 🛑 This is the opposite of `CarouselEntry.finish_date`, which is EXCLUSIVE for the same
     * week. Never feed this field to `isDateInHalfOpenRange`; add a day first (`addDay`), the
     * way `src/clarity/ui/src/server/fill.ts` does when it builds `exclusiveEnd`.
     */
    timePeriodFinish: string;
    timePeriodId: number;
    timePeriodOffset: number;
    version: number;
    status: LookupField; // id: "0"=Open, "1"=Submitted, "2"=Reverted
    resourceName: string;
    uniqueName: string;
    lastUpdatedDate: string;
    lastUpdatedBy: string;
    numberOfEntries: number;
    hasNotes: boolean;
    numberOfNotes: number;
    hasAssignments: boolean;
    timePeriodIsOpen: boolean;
    employmentType: LookupField;
    resourceType: LookupField;
    _authorization: TimesheetAuthorization;
    timeentries: TimeEntriesSection;
    timesheetNotes: { _self: string } | TimesheetNotesExpanded;
    timeEntries: { _self: string }; // camelCase variant
    // Optional fields
    definedTeamId: number | null;
    isBeingAdjusted: boolean;
    approvedBy: string | null;
    vendor: string | null;
    submittedBy: string | null;
    failedrules: string | null;
    daysOverdue: number | null;
    postedTime: string | null;
    adjustedTimesheetId: number | null;
    isAdjustment: boolean;
    resourceObsFilter: string | null;
    prmodBY: LookupField;
    resourceManager: string;
    resourceManagerName: LookupField;
    attestationMessage: string;
    timePeriod: LookupField;
}

export interface TimesheetAuthorization {
    view: boolean;
    edit: boolean;
    approve: boolean;
    adjust: boolean;
    delete: boolean;
    return: boolean;
}

// -- Timesheet Notes --
export interface TimesheetNote {
    _internalId: number;
    noteText: string;
    resourceId: number;
    lastUpdatedDate: string;
    _parent: string;
    createdDate: string;
    noteDate: string | null;
    author: number;
    resourceName: string;
    _self: string;
    resourceFirstName: string;
}

export interface TimesheetNotesExpanded {
    _pageSize: number;
    _self: string;
    _metadata: Record<string, unknown>;
    _totalCount: number;
    _results: TimesheetNote[];
    _recordsReturned: number;
}

export type TimesheetWithNotesResponse = TimesheetRecord;

// -- Time Entries --
export interface TimeEntriesSection {
    _self: string;
    _results: TimeEntryRecord[];
}

export interface TimeEntryRecord {
    _internalId: number; // timeEntryId (e.g. 10311311)
    resourceId: number;
    taskId: number; // internal task ID (e.g. 8366010)
    taskCode: string; // e.g. "00070705"
    taskName: string; // e.g. "SampleTask_Release_External_Capex"
    taskFullName: string; // e.g. "FixedPart/SampleTask_Release_External_Capex"
    taskShortName: string | null;
    taskStartDate: string;
    taskFinishDate: string;
    phaseName: string; // e.g. "FixedPart"
    phaseId: string;
    parentTaskName: string;
    parentTaskId: string;
    investmentId: number;
    investmentName: string; // e.g. "Sample Project"
    investmentCode: string; // e.g. "P100001"
    investmentType: string; // e.g. "project"
    investmentAlias: string;
    invBlueprintId: string;
    isInvestmentActive: boolean;
    isTeamInvestment: number;
    assignmentId: number;
    role: LookupField;
    etc: number; // Estimate to complete (minutes)
    etcOriginal: number | null;
    totalActuals: number; // Total actuals (seconds)
    postedActuals: number;
    baseline: number;
    actuals: TimeSeriesValue;
    _authorization: { view: boolean; edit: boolean; delete: boolean };
    _self: string;
    resourceFirstName: string;
    resourceLastName: string;
    lastUpdatedBy: string;
    lastUpdatedDate: string;
    numberOfNotes: number;
    timeEntryNotes: { _self: string };
    inputTypeCode: string | null;
    chargeCode: string | null;
    userValue1: string | null;
    userValue2: string | null;
}

// -- Time Series Value (used in actuals & PUT body) --
export interface TimeSeriesValue {
    isFiscal: boolean;
    curveType: string; // "value"
    total?: number; // present in responses, omit in requests (API calculates from segments)
    dataType: string; // "numeric"
    _type: string; // "tsv"
    start: string; // ISO — first day of period (inclusive)
    finish: string; // ISO — last day of period (inclusive, NOT exclusive)
    segmentList: SegmentList;
}

// Debug info captured from Clarity API requests (for verbose logging)
export interface ApiDebugInfo {
    url: string;
    method: string;
    requestBody: unknown;
    responseStatus: number;
    responseBody: unknown;
}

export interface SegmentList {
    total: number;
    defaultValue: number;
    segments: TimeSegment[];
}

export interface TimeSegment {
    start: string; // ISO "2026-02-09T00:00:00"
    finish: string; // same as start (single day)
    value: number; // seconds! 3600 = 1h, 5400 = 1.5h
}

// -- Shared types --
export interface LookupField {
    displayValue: string;
    _type: string; // "lookup"
    id: string;
}

// -- Resource --
export interface ResourceSection {
    _self: string;
    _results: ResourceRecord[];
}

export interface ResourceRecord {
    id: number; // resourceId
    user_id: number;
    first_name: string;
    last_name: string;
    full_name: string;
    email: string;
    roleName: string;
    is_active: string;
    prtrackmode: string;
    prisopen: boolean;
    canApprove: boolean;
    canEnterTimeForOthers: boolean;
    definedTeamId: number;
    teamMemberCount: number;
    resource_type: { _self: string; _results: LookupField[] };
    _self: string;
}

export interface ResourceCalendarSection {
    _self: string;
    _results: CalendarDay[];
}

// -- TimesheetApp response (for discovery) --
export interface TimesheetAppResponse {
    calendar: CalendarSection;
    tpcounts: TimePeriodCounts;
    resource: ResourceSection;
    resourcecalendar: ResourceCalendarSection;
    options: Record<string, unknown>;
    tscarousel: TimesheetCarousel;
    timesheets: TimesheetsSection;
    _self: string;
    _metadata: { virtualResource: string };
}

export interface TimePeriodCounts {
    resourceId: number;
    prev_count: number;
    next_count: number;
}

export interface TimesheetCarousel {
    _self: string;
    _results: CarouselEntry[];
}

export interface CarouselEntry {
    id: number; // timePeriodId
    /**
     * THE timesheetId we need. Absent on future periods Clarity has not opened a timesheet for;
     * sending `timesheetId=undefined` answers `API-1006 invalidAttrValue`.
     */
    timesheet_id: number;
    start_date: string; // ISO, first day of the period
    /**
     * ISO, and EXCLUSIVE: the first day that no longer belongs to the period. Adjacent periods
     * therefore share a boundary date. The week of 2026-08-24 reports finish_date 2026-08-31,
     * while the next period reports start_date 2026-08-31.
     *
     * 🛑 The same week's timesheet reports `timePeriodFinish` 2026-08-30, which is INCLUSIVE.
     * Two fields, two meanings, one day apart. Match dates against this one with
     * `isDateInHalfOpenRange(date, start_date, finish_date)` from `@genesiscz/utils/date`;
     * an inclusive comparison here assigns every boundary day to the earlier week.
     */
    finish_date: string;
    total: number; // total hours logged
    prstatus: LookupField; // status
    _self: string;
}
