export interface BrowserCandidate {
    uid: string;
    role: string;
    name: string;
    value?: string;
    clickable: boolean;
    fillable: boolean;
    x?: number;
    y?: number;
}

export interface BrowserObservation {
    url: string;
    title: string;
    candidates: BrowserCandidate[];
    headings: Array<{ level: number; text: string }>;
}

export interface BrowserAction {
    verb: "click" | "fill" | "back" | "scroll" | "wait" | "stop" | "navigate";
    uid?: string;
    text?: string;
    url?: string;
}

export interface BrowserDispatchResult {
    ok: boolean;
    overlay: boolean;
    error?: string;
    after?: BrowserObservation;
}

export interface BrowserDriver {
    observe(): Promise<BrowserObservation>;
    dispatch(action: BrowserAction, inputs: Record<string, string>): Promise<BrowserDispatchResult>;
}
