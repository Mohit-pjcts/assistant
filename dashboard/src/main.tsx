import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./lib/theme";
import { UiScaleProvider } from "./lib/uiScale";
import "./index.css";

// PLAN.md Phase 29 Stage 2: AstryxThemeBridge removed — Astryx is gone
// entirely (its own theme provider had nothing left to wrap once every
// consuming component was migrated to plain shadcn/Tailwind +
// InstrumentCard). ThemeProvider's existing .dark class toggle is now the
// ONLY theme mechanism in the app, same as it always was for every
// non-Astryx panel.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <UiScaleProvider>
        <App />
      </UiScaleProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
