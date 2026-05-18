import {
    getAllDistrictNames,
    getPrahaDistrictNames,
    searchDistricts,
} from "@app/Internal/commands/reas/data/districts";
import { apiHandler } from "@app/Internal/commands/reas/ui/src/server/api-utils";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/districts")({
    server: {
        handlers: {
            GET: apiHandler(async (request) => {
                const url = new URL(request.url);
                const query = url.searchParams.get("q");

                if (query) {
                    const results = searchDistricts(query).map((d) => ({
                        name: d.name,
                        reasId: d.reasId,
                    }));
                    return Response.json({ districts: results });
                }

                const districts = getAllDistrictNames();
                const praha = getPrahaDistrictNames();

                return Response.json({ districts, praha });
            }),
        },
    },
});
