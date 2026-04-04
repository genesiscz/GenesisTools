import { getLatestMfUrl, MfRentalClient, mfRentalClient } from "./MfRentalClient";

export { getLatestMfUrl, MfRentalClient };

export async function fetchMfRentalData(municipality: string, refresh = false) {
    return mfRentalClient.fetchRentalData(municipality, refresh);
}

export async function fetchMfRentalDataForDistrict(districtName: string, refresh = false) {
    return mfRentalClient.fetchRentalDataForDistrict(districtName, refresh);
}
