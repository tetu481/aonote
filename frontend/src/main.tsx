import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LocaleProvider } from "./LocaleContext";
import { applyLocaleMetadata, readStoredLocale } from "./locales";
import { applyTheme, readStoredTheme } from "./theme";

const initialLocale = readStoredLocale();
applyLocaleMetadata(initialLocale);
applyTheme(readStoredTheme());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><LocaleProvider initialLocale={initialLocale}><App /></LocaleProvider></React.StrictMode>,
);
