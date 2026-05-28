import { RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { getRouter } from "@/router";
import "./styles.css";

function preventMobileBrowserZoomGestures(): void {
    for (const type of ["gesturestart", "gesturechange", "gestureend"] as const) {
        document.addEventListener(
            type,
            (event) => {
                event.preventDefault();
            },
            { passive: false }
        );
    }
}

preventMobileBrowserZoomGestures();

const router = getRouter();
const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
    const root = ReactDOM.createRoot(rootElement);
    root.render(
        <StrictMode>
            <RouterProvider router={router} />
        </StrictMode>
    );
}
