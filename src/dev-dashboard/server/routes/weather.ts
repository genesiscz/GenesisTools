import { getConfig } from "@app/dev-dashboard/config";
import { fetchWeather } from "@app/dev-dashboard/lib/weather/client";
import { errorResult } from "@app/dev-dashboard/server/routes/error";
import type { RouteDef } from "@app/dev-dashboard/server/types";

export function weatherRoutes(): RouteDef[] {
    return [
        {
            method: "GET",
            pattern: "/api/weather",
            handler: async () => {
                try {
                    const { weatherCoords } = await getConfig();

                    return { kind: "json", status: 200, body: await fetchWeather(weatherCoords) };
                } catch (err) {
                    return errorResult(err);
                }
            },
        },
    ];
}
