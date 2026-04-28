export interface AvailableMemory {
    id: number;
    app: string;
    note: string;
    from: string;
    to: string;
    duration_min: number;
    sub_notes: string[];
}

export interface PlanSuggestion {
    project_id: number;
    project_name: string;
    score: number;
    reasons: string[];
}

export interface PlanEvent {
    project_id: number;
    note: string;
    memory_ids: number[];
}

export interface PlanDay {
    day: string;
    available_memories: AvailableMemory[];
    suggestions: PlanSuggestion[];
    events: PlanEvent[];
}

export interface CreatePlanV1 {
    version: 1;
    generated_at: string;
    days: PlanDay[];
}

export interface PlanIssue {
    severity: "error" | "warn";
    day: string;
    eventIdx?: number;
    message: string;
}
