import logger from "@app/logger";
import axios, { type AxiosInstance, type InternalAxiosRequestConfig } from "axios";

export interface JenkinsAuth {
    url: string;
    user: string;
    token: string;
}

export function readEnvAuth(): JenkinsAuth {
    const url = process.env.JENKINS_URL ?? "";
    const user = process.env.JENKINS_USER ?? "";
    const token = process.env.JENKINS_TOKEN ?? "";

    if (!url || !user || !token) {
        const missing = [!url && "JENKINS_URL", !user && "JENKINS_USER", !token && "JENKINS_TOKEN"]
            .filter(Boolean)
            .join(", ");
        throw new Error(`Missing required Jenkins env vars: ${missing}`);
    }

    return { url, user, token };
}

interface RetryConfig extends InternalAxiosRequestConfig {
    _retry?: number;
}

export function createClient(auth: JenkinsAuth): AxiosInstance {
    const instance = axios.create({
        baseURL: auth.url,
        auth: { username: auth.user, password: auth.token },
        timeout: 30_000,
        validateStatus: () => true,
    });

    instance.interceptors.response.use(undefined, async (error) => {
        const cfg = error.config as RetryConfig | undefined;

        if (!cfg) {
            throw error;
        }

        cfg._retry = (cfg._retry ?? 0) + 1;
        const status = error.response?.status as number | undefined;
        const retriable = status === undefined || (status >= 500 && status < 600);

        if (cfg._retry > 3 || !retriable) {
            throw error;
        }

        const delay = 250 * 2 ** (cfg._retry - 1);
        logger.debug(`Jenkins retry ${cfg._retry}/3 for ${cfg.url} after ${delay}ms (status=${status ?? "net"})`);
        await new Promise((resolve) => setTimeout(resolve, delay));
        return instance.request(cfg);
    });

    return instance;
}
