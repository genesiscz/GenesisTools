// ============================================
// Common Types
// ============================================

export interface Currency {
    id: string;
    name: string;
    iso_code: string;
    symbol: string;
    symbol_first: boolean;
}

export interface Duration {
    hours: number;
    minutes: number;
    seconds: number;
    formatted: string;
    total_hours: number;
    total_seconds: number;
    total_minutes: number;
}

export interface Cost {
    fractional: number;
    formatted: string;
    amount: number;
    currency_code: string;
}

export interface Avatar {
    large_retina: string;
    large: string;
    medium_retina: string;
    medium: string;
    timeline: string;
}

export interface Logo {
    large_retina: string;
    medium_retina: string;
    small_retina: string;
    brand_logo: boolean;
}

// ============================================
// Account
// ============================================

export interface TimelyAccount {
    id: number;
    name: string;
    color: string;
    currency: Currency;
    logo: Logo;
    from: string;
    max_users: number;
    seats: number;
    max_projects: number;
    plan_id: number;
    plan_name: string;
    plan_code: string;
    next_charge: string;
    start_of_week: number;
    created_at: number;
    payment_mode: string;
    paid: boolean;
    company_size: string;
    owner_id: number;
    weekly_user_capacity: number;
    default_work_days: string;
    default_hour_rate: number;
    support_email: string;
    memory_retention_days: number;
    num_users: number;
    num_projects: number;
    active_projects_count: number;
    total_projects_count: number;
    capacity: Duration;
    status: string;
    beta: boolean;
    expired: boolean;
    trial: boolean;
    days_to_end_trial: number;
    features: Array<{ name: string; days: number }>;
}

// ============================================
// Client
// ============================================

export interface TimelyClient {
    id: number;
    name: string;
    color: string;
    active: boolean;
    external_id: string | null;
    updated_at: string;
}

// ============================================
// Label
// ============================================

export interface TimelyLabel {
    id: number;
    name: string;
    sequence: number;
    parent_id: number | null;
    emoji: string | null;
    children: TimelyLabel[];
}

// ============================================
// Project
// ============================================

export interface TimelyProject {
    id: number;
    active: boolean;
    account_id: number;
    name: string;
    description: string;
    color: string;
    rate_type: string;
    billable: boolean;
    created_at: number;
    updated_at: number;
    external_id: string | null;
    budget_scope: string | null;
    client: TimelyClient | null;
    required_notes: boolean;
    required_labels: boolean;
    budget_expired_on: string | null;
    has_recurrence: boolean;
    enable_labels: string;
    default_labels: boolean;
    currency: Currency;
    team_ids: number[];
    budget: number;
    budget_type: string;
    budget_calculation: string;
    hour_rate: number;
    hour_rate_in_cents: number;
    budget_progress: number;
    budget_percent: number;
    invoice_by_budget: boolean;
    labels: TimelyLabel[];
    label_ids: number[];
    required_label_ids: number[];
    default_label_ids: number[];
    created_from: string;
}

// ============================================
// User
// ============================================

export interface TimelyUser {
    id: number;
    email: string;
    name: string;
    avatar: Avatar;
    updated_at: string;
}

// ============================================
// Event (Time Entry)
// ============================================

export interface TimelyEvent {
    id: number;
    uid: string;
    user: TimelyUser;
    project: TimelyProject;
    duration: Duration;
    estimated_duration: Duration;
    cost: Cost;
    estimated_cost: Cost;
    day: string; // YYYY-MM-DD
    note: string;
    sequence: number;
    estimated: boolean;
    timer_state: string;
    timer_started_on: number;
    timer_stopped_on: number;
    label_ids: number[];
    user_ids: number[];
    updated_at: number;
    created_at: number;
    created_from: string;
    updated_from: string;
    billed: boolean;
    billable: boolean;
    to: string;
    from: string;
    deleted: boolean;
    hour_rate: number;
    hour_rate_in_cents: number;
    creator_id: number | null;
    updater_id: number | null;
    external_id: string | null;
    entry_ids: number[];
    suggestion_id: number | null;
    draft: boolean;
    manage: boolean;
    forecast_id: number | null;
    billed_at: string | null;
    locked_reason: string | null;
    locked: boolean;
    invoice_id: number | null;
    timestamps: unknown[];
    state: string | null;
    external_links: unknown[];
}

// ============================================
// Create Event Input
// ============================================

export interface CreateEventInput {
    day: string; // YYYY-MM-DD
    hours: number;
    minutes: number;
    note?: string;
    project_id?: number;
    user_id?: number;
    from?: string; // HH:MM
    to?: string; // HH:MM
    estimated_hours?: number;
    estimated_minutes?: number;
    label_ids?: number[];
    external_id?: string;
}

// ============================================
// Entry (from suggested_entries.json endpoint)
// ============================================

export interface TimelySubEntry {
    id: number;
    uid: string;
    entry_id: number;
    from: string; // ISO datetime
    to: string; // ISO datetime
    note: string;
    duration: Duration;
}

export interface TimelyExtraAttribute {
    name: string;
    value: string;
}

export interface TimelyEntry {
    id: number;
    type: string; // e.g., "macOS"
    uid: string;
    title: string; // Application name, e.g., "Cursor"
    note: string; // Main note/description
    description: string;
    date: string; // YYYY-MM-DD
    from: string; // ISO datetime
    to: string; // ISO datetime
    entry_type: string | null;
    duration: Duration;
    at: string; // ISO datetime
    extra_attributes: TimelyExtraAttribute[];
    icon: string | null;
    color: string | null;
    sub_entries: TimelySubEntry[];
    icon_url: string;
    icon_fallback_url: string;
    url: string;
    entry_ids?: number[]; // Present on suggested_entries (memories) — IDs of sub-entries
}

// TimelyEntryResponse is now just an array of TimelyEntry
// The cache metadata is handled separately by Storage
export type TimelyEntryResponse = TimelyEntry[];

// ============================================
// API Responses
// ============================================

export interface PaginatedResponse<T> {
    data: T[];
    page: number;
    per_page: number;
    total_pages: number;
    total_count: number;
}

// ============================================
// Slim Types for Token-Efficient Output
// ============================================

/** Slim event for token-efficient JSON output */
export interface TimelyEventSlim {
    id: number;
    day: string;
    project: { id: number; name: string };
    duration: string; // "HH:MM" e.g. "04:51"
    note: string;
    from: string | null; // "10:00" or null
    to: string | null; // "14:51" or null
    entry_ids: number[];
    billed: boolean;
    billable: boolean;
    cost: number; // amount as number
    entries?: TimelyEntry[]; // only with --with-entries
}
