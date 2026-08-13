import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import { RegionSelector } from "./screens/RegionSelector";
import { RecNotify } from "./screens/RecNotify";
import { RecBorder } from "./screens/RecBorder";

const label = getCurrentWindow().label;

if (label === "region_selector" || label === "rec_notify" || label === "rec_border") {
  document.documentElement.style.background = "transparent";
  document.body.style.cssText = "background: transparent; margin: 0";
}

const root = document.getElementById("root") as HTMLElement;

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    {label === "region_selector" ? <RegionSelector />
      : label === "rec_notify" ? <RecNotify />
      : label === "rec_border" ? <RecBorder />
      : <App />}
  </React.StrictMode>,
);
