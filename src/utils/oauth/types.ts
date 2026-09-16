export interface DeviceCodeResponse {
    device_code: string;
    user_code: string;
    verification_uri: string;
    interval: number;
    expires_in: number;
}

export interface DeviceFlowConfig {
    clientId: string;
    /**
     * Set only when dynamic registration produced a CONFIDENTIAL client. An
     * authorization server that registered the client with client_secret_post refuses
     * both the device-authorization request and the token poll without it, with
     * `invalid_client: Missing client_secret`.
     */
    clientSecret?: string;
    scope: string;
    deviceCodeUrl: string;
    tokenUrl: string;
    userAgent?: string;
}

export interface DeviceFlowCallbacks {
    onUserCode: (info: { userCode: string; verificationUri: string }) => void;
}

export interface DeviceTokenSuccess {
    access_token: string;
    token_type?: string;
    scope?: string;
    /**
     * RFC 6749 lifetime of the ACCESS TOKEN, in seconds. Distinct from the
     * `expires_in` of RFC 8628's device-authorization response, which is the lifetime
     * of the device_code and user_code and is usually far shorter.
     */
    expires_in?: number;
    refresh_token?: string;
}

export interface DeviceTokenError {
    error: string;
    error_description?: string;
    interval?: number;
}
