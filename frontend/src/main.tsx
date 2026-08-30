import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { uiText } from "./locales";
import { applyTheme, readStoredTheme } from "./theme";

document.documentElement.lang = uiText.meta.language;
document.querySelector<HTMLMetaElement>('meta[name="description"]')?.setAttribute("content", uiText.meta.description);
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><App /></React.StrictMode>,
);
