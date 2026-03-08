import "./styles.css";
import { createDashboardApp } from "@ui/create-app";
import { App } from "./App";

createDashboardApp({
    App,
    toaster: {
        toastOptions: {
            style: {
                background: "#1a1a2e",
                border: "1px solid rgba(245, 158, 11, 0.2)",
                color: "#e5e7eb",
                fontFamily: "monospace",
            },
        },
    },
});
