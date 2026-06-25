export interface ExposureEnsureResult {
    started: boolean;
    message: string;
    pid?: number;
    alreadyRunning?: boolean;
}

export interface ExposureVerifyResult {
    ok: boolean;
    url: string;
    detail: string;
}
