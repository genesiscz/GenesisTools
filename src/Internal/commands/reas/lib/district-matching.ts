import { getAllDistrictNames, getPrahaDistrictNames } from "@app/Internal/commands/reas/data/districts";

const PRAHA_WARD_REGEX = /^Praha\s+\d+$/i;

const DISTRICT_NAMES = [...getPrahaDistrictNames(), ...getAllDistrictNames()].sort((left, right) => {
    if (left === "Praha") {
        return 1;
    }

    if (right === "Praha") {
        return -1;
    }

    return normalizeDistrictMatchText(right).length - normalizeDistrictMatchText(left).length;
});

export function normalizeDistrictMatchText(value: string): string {
    return value
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9]+/g, " ")
        .trim()
        .toLowerCase();
}

export function isPrahaWardName(value: string): boolean {
    return PRAHA_WARD_REGEX.test(value.trim());
}

export function deriveDistrictFromLocation(locality: string | null | undefined): string | undefined {
    if (!locality?.trim()) {
        return undefined;
    }

    const normalizedLocality = ` ${normalizeDistrictMatchText(locality)} `;

    for (const districtName of DISTRICT_NAMES) {
        const normalizedDistrict = normalizeDistrictMatchText(districtName);

        if (!normalizedDistrict) {
            continue;
        }

        if (normalizedLocality.includes(` ${normalizedDistrict} `)) {
            return districtName;
        }
    }

    return undefined;
}

export function matchesRequestedDistrict({
    requestedDistrict,
    locality,
}: {
    requestedDistrict: string;
    locality: string | null | undefined;
}): boolean {
    if (!locality?.trim()) {
        return true;
    }

    const derivedDistrict = deriveDistrictFromLocation(locality);

    if (derivedDistrict) {
        if (requestedDistrict === "Praha") {
            return derivedDistrict === "Praha" || isPrahaWardName(derivedDistrict);
        }

        return derivedDistrict === requestedDistrict;
    }

    const normalizedLocality = normalizeDistrictMatchText(locality);
    const normalizedRequestedDistrict = normalizeDistrictMatchText(requestedDistrict);

    return normalizedLocality.includes(normalizedRequestedDistrict);
}

export function getListingPersistenceDistrict({
    requestedDistrict,
    locality,
}: {
    requestedDistrict: string;
    locality: string | null | undefined;
}): string {
    const derivedDistrict = deriveDistrictFromLocation(locality);

    if (!derivedDistrict) {
        return requestedDistrict;
    }

    if (requestedDistrict === "Praha" && isPrahaWardName(derivedDistrict)) {
        return requestedDistrict;
    }

    return derivedDistrict;
}
