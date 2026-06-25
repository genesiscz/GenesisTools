import type { UsageSummary } from "@app/ai-proxy/lib/types";

export interface OpenAiModel {
    id: string;
    object: "model";
    created: number;
    owned_by: string;
    description?: string;
}

export interface ProxyProvider {
    id: string;
    readonly accountFingerprint: string;
    listModels(): Promise<OpenAiModel[]>;
    chatCompletions(req: Request, model: string, bodyText: string): Promise<Response>;
    responses(req: Request, model: string, bodyText: string): Promise<Response>;
    getUsage(): Promise<UsageSummary>;
}
