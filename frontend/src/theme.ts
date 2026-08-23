export type Theme = "light" | "dark";

export const THEME_STORAGE_KEY = "aonote:theme:v1";

const themeColors: Record<Theme, string> = {
  light: "#eef7ff",
  dark: "#071321",
};

export function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute("content", themeColors[theme]);
}

export function persistTheme(theme: Theme) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // localStorageが無効でも、そのセッション中のテーマは継続する。
  }
}
