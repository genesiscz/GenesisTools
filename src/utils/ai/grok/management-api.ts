import { SafeJSON } from "@app/utils/json";
import { GROK_MANAGEMENT_API_BASE_URL } from "./paths";

export interface ManagementUsageRequest {
    teamId: string;
    startTime?: string;
    endTime?: string;
    groupBy?: string[];
}

export class GrokManagementClient {
    private readonly managementKey: string;
    private readonly baseUrl: string;

    constructor(managementKey: string, baseUrl: string = GROK_MANAGEMENT_API_BASE_URL) {
        this.managementKey = managementKey;
        this.baseUrl = baseUrl;
    }

    private headers(): Record<string, string> {
        return {
            Authorization: `Bearer ${this.managementKey}`,
            "Content-Type": "application/json",
        };
    }

    async getPrepaidBalance(teamId: string): Promise<unknown> {
        const safeTeamId = encodeURIComponent(teamId);
        const response = await fetch(`${this.baseUrl}/billing/teams/${safeTeamId}/prepaid-balance`, {
            headers: this.headers(),
        });

        if (!response.ok) {
            throw new Error(`Management API prepaid-balance failed: HTTP ${response.status}`);
        }

        return response.json();
    }

    async getTeamUsage(request: ManagementUsageRequest): Promise<unknown> {
        const safeTeamId = encodeURIComponent(request.teamId);
        const response = await fetch(`${this.baseUrl}/billing/teams/${safeTeamId}/usage`, {
            method: "POST",
            headers: this.headers(),
            body: SafeJSON.stringify({
                start_time: request.startTime,
                end_time: request.endTime,
                group_by: request.groupBy,
            }),
        });

        if (!response.ok) {
            throw new Error(`Management API usage failed: HTTP ${response.status}`);
        }

        return response.json();
    }
}
