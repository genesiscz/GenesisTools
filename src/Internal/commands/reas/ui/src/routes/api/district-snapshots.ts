import { serializeDistrictSnapshot } from "@app/Internal/commands/reas/lib/district-snapshot";
import { reasDatabase } from "@app/Internal/commands/reas/lib/store";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler } from "../../server/api-utils";

export const Route = createFileRoute("/api/district-snapshots")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const district = url.searchParams.get("district");
                const districts = url.searchParams
                    .get("districts")
                    ?.split(",")
                    .map((value) => value.trim())
                    .filter(Boolean);
                const constructionType = url.searchParams.get("type") ?? "brick";
                const days = url.searchParams.get("days");
                const historyDays = days ? Number(days) : 365;

                if (!district && (!districts || districts.length === 0)) {
                    return Response.json(
                        { error: "Missing required parameter: district or districts" },
                        { status: 400 }
                    );
                }

                if (districts && districts.length > 0) {
                    const snapshotsByDistrict = Object.fromEntries(
                        districts.map((districtName) => [
                            districtName,
                            reasDatabase
                                .getDistrictHistory(districtName, constructionType, historyDays)
                                .map(serializeDistrictSnapshot),
                        ])
                    );

                    return Response.json({ snapshotsByDistrict });
                }

                const snapshots = reasDatabase.getDistrictHistory(district!, constructionType, historyDays);

                const rows = snapshots.map(serializeDistrictSnapshot);

                return Response.json({ snapshots: rows });
            }),
        },
    },
});
