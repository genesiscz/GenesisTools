import { eventHandler } from "h3";

export default eventHandler(() => {
    return {
        status: "healthy",
        timestamp: new Date().toISOString(),
        service: "@dashboard/server",
        version: "0.0.1",
    };
});
