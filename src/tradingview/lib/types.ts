export interface QuoteValue {
    lp?: number;
    ch?: number;
    chp?: number;
    volume?: number;
    short_name?: string;
    description?: string;
    pro_name?: string;
    currency_code?: string;
    lp_time?: number;
    [field: string]: unknown;
}

export interface QuoteSnapshot {
    symbol: string;
    value: QuoteValue;
    updatedAt: number;
}

export interface TvSession {
    username: string;
    userId: number;
    cookie: string;
}

export interface AlertCondition {
    type: string;
    frequency: string;
    series: Array<{ type: string; value?: number }>;
    cross_interval?: boolean;
    resolution: string;
}

export interface Alert {
    alert_id: number;
    symbol: string;
    pro_symbol?: string;
    resolution: string;
    condition: AlertCondition;
    message: string;
    name: string | null;
    active: boolean;
    type: string;
    expiration: string | null;
    create_time: string;
    last_fire_time: string | null;
    last_error: string | null;
    last_stop_reason: string | null;
    web_hook: string | null;
    email: boolean;
    mobile_push: boolean;
    popup: boolean;
    kinds: string[];
}

export interface AlertFire {
    fire_id: number;
    alert_id: number;
    symbol: string;
    pro_symbol?: string;
    message: string;
    fire_time: string;
    bar_time: string;
    resolution: string;
    name: string | null;
    kinds: string[];
}

export type AlertEvent =
    | { kind: "fired"; fire: AlertFire }
    | { kind: "created"; alerts: Alert[] }
    | { kind: "updated"; alerts: Alert[] };
