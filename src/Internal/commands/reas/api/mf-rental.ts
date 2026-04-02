import { getLatestMfUrl, MfRentalClient, mfRentalClient } from "./MfRentalClient";

export { getLatestMfUrl, MfRentalClient };

export async function fetchMfRentalData(municipality: string, refresh = false) {
    return mfRentalClient.fetchRentalData(municipality, refresh);
}
