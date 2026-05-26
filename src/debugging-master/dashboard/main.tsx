import { StrictMode } from "react";
import ReactDOM from "react-dom/client";

import "react-mosaic-component/react-mosaic-component.css";
import "./styles.css";
import { App } from "./App";

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
    ReactDOM.createRoot(rootElement).render(
        <StrictMode>
            <App />
        </StrictMode>
    );
}
