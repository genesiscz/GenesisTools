import { compareDistricts } from "@app/Internal/commands/reas/lib/district-comparison-service";
import type { DistrictSnapshotResolution } from "@app/Internal/commands/reas/lib/district-snapshot";
import { createFileRoute } from "@tanstack/react-router";
import { apiHandler, jsonBody } from "../../server/api-utils";

export const Route = createFileRoute("/api/district-comparison")({
    server: {
        handlers: {
            POST: apiHandler(async (request) => {
                const body = await jsonBody(request);

                if (body instanceof Response) {
                    return body;
                }

                const districts = Array.isArray(body.districts)
                    ? body.districts.filter((value): value is string => typeof value === "string")
                    : [];

                if (districts.length === 0) {
                    return Response.json({ error: "Missing required field: districts" }, { status: 400 });
                }

                const comparisons = await compareDistricts({
                    districts,
                    constructionType: (body.type as string | undefined) ?? "brick",
                    disposition: body.disposition as string | undefined,
                    periods: body.periods as string | undefined,
                    price: Number(body.price ?? 5000000),
                    area: Number(body.area ?? 80),
                    rent: body.rent ? Number(body.rent) : undefined,
                    monthlyCosts: body.monthlyCosts ? Number(body.monthlyCosts) : undefined,
                    providers: body.providers as string | undefined,
                    refresh: body.refresh === true,
                    snapshotResolution: (body.snapshotResolution === "daily"
                        ? "daily"
                        : "monthly") as DistrictSnapshotResolution,
                });

                return Response.json({ comparisons });
            }),
        },
    },
});
