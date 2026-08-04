import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import { UiScaleProvider } from "./lib/uiScale";
import { AstryxThemeBridge } from "./components/theme/AstryxThemeBridge";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <UiScaleProvider>
        <AstryxThemeBridge>
          <App />
        </AstryxThemeBridge>
      </UiScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
