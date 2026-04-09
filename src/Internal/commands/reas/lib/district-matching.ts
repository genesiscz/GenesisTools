import {
    getAllDistrictNames,
    getPrahaDistrictNames,
    neighborhoodMatchesWard,
} from "@app/Internal/commands/reas/data/districts";

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

        if (derivedDistrict === requestedDistrict) {
            return true;
        }

        // Bezrealitky uses neighborhood names ("Praha - Žižkov") instead of ward
        // numbers ("Praha 3"). When derived district is "Praha" but the request
        // is for a specific ward, check if any neighborhood in the locality maps
        // to that ward.
        if (derivedDistrict === "Praha" && isPrahaWardName(requestedDistrict)) {
            const wardNumber = Number(requestedDistrict.replace(/\D/g, ""));

            return localityContainsMatchingNeighborhood(locality, wardNumber);
        }

        return false;
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

function localityContainsMatchingNeighborhood(locality: string | null | undefined, wardNumber: number): boolean {
    if (!locality) {
        return false;
    }

    // Extract neighborhood from patterns like "Praha - Žižkov", "Praha, Žižkov"
    const separatorMatch = /Praha\s*[-–,]\s*(.+)/i.exec(locality);

    if (separatorMatch) {
        const neighborhood = separatorMatch[1].trim();

        return neighborhoodMatchesWard(neighborhood, wardNumber);
    }

    return false;
}
