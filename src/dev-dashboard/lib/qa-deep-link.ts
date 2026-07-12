import { publicBaseUrl } from "@app/dev-dashboard/lib/public-base";

export async function buildQaDeepLink(entryId: string): Promise<string> {
    return `${await publicBaseUrl()}/qa?id=${encodeURIComponent(entryId)}`;
}
