import { describe, expect, test } from "bun:test";
import {
    buildListingsSnapshotTargets,
    buildSuccessfulListingsSnapshotTargets,
} from "@app/Internal/commands/reas/lib/analysis-service";
import type { AnalysisFilters } from "@app/Internal/commands/reas/types";

const filters: AnalysisFilters = {
    estateType: "flat",
    constructionType: "brick",
    periods: [],
    district: {
        name: "Praha 4",
        reasId: 3100,
        srealityId: 10,
        srealityLocality: "region",
    },
    providers: ["reas", "sreality", "bezrealitky", "ereality"],
};

describe("buildListingsSnapshotTargets", () => {
    test("includes requested providers even when stricter filtering leaves no persisted rows", () => {
        expect(buildListingsSnapshotTargets({ filters, listingType: "rental" })).toEqual([
            { type: "rental", source: "sreality", sourceContract: "sreality-v2" },
            { type: "rental", source: "bezrealitky", sourceContract: "graphql:listAdverts" },
            { type: "rental", source: "ereality", sourceContract: "ereality-html" },
        ]);
    });

    test("builds all snapshot targets for full analysis persistence", () => {
        expect(buildListingsSnapshotTargets({ filters })).toEqual([
            { type: "sold", source: "reas", sourceContract: "reas-catalog" },
            { type: "sale", source: "sreality", sourceContract: "sreality-v2" },
            { type: "sale", source: "bezrealitky", sourceContract: "graphql:listAdverts:sale" },
            { type: "rental", source: "sreality", sourceContract: "sreality-v2" },
            { type: "rental", source: "bezrealitky", sourceContract: "graphql:listAdverts" },
            { type: "rental", source: "ereality", sourceContract: "ereality-html" },
        ]);
    });
});

describe("buildSuccessfulListingsSnapshotTargets", () => {
    test("keeps zero-result successful refresh targets but skips failed providers", () => {
        expect(
            buildSuccessfulListingsSnapshotTargets({
                filters,
                listingType: "rental",
                providerSuccess: {
                    "sreality:rental": true,
                    "bezrealitky:rental": false,
                    "ereality:rental": true,
                },
            })
        ).toEqual([
            { type: "rental", source: "sreality", sourceContract: "sreality-v2" },
            { type: "rental", source: "ereality", sourceContract: "ereality-html" },
        ]);
    });

    test("skips sold snapshot cleanup when any REAS sold fetch failed", () => {
        expect(
            buildSuccessfulListingsSnapshotTargets({
                filters,
                listingType: "sold",
                providerSuccess: {
                    "reas:sold": false,
                },
            })
        ).toEqual([]);
    });

    test("keeps mixed same-provider cleanup scoped to the successful listing type", () => {
        expect(
            buildSuccessfulListingsSnapshotTargets({
                filters,
                providerSuccess: {
                    "reas:sold": true,
                    "sreality:sale": true,
                    "sreality:rental": false,
                    "bezrealitky:sale": false,
                    "bezrealitky:rental": true,
                    "ereality:rental": true,
                },
            })
        ).toEqual([
            { type: "sold", source: "reas", sourceContract: "reas-catalog" },
            { type: "sale", source: "sreality", sourceContract: "sreality-v2" },
            { type: "rental", source: "bezrealitky", sourceContract: "graphql:listAdverts" },
            { type: "rental", source: "ereality", sourceContract: "ereality-html" },
        ]);
    });
});
