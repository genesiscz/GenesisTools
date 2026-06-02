export interface ZoneLine {
    zone: string;
    label: string;
    weekday: string;
    date: string;
    time: string;
    offset: string;
    epochMs: number;
}

export interface ParseResult {
    epochMs: number;
    sourceLabel: string;
    target?: string;
}

export interface ConvertInput {
    expr: string;
    nowMs: number;
    localZone: string;
    to?: string[];
}

export interface ConvertResult {
    sourceLabel: string;
    lines: ZoneLine[];
}
