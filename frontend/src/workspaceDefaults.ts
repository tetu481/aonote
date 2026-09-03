import type { Locale } from "./locales";

export const DEFAULT_WELCOME_FOLDER_NAME = "ようこそ";
export const DEFAULT_WELCOME_NOTE_FILENAME = "01-ようこそ.md";
export const DEFAULT_ADMIN_ACTOR_NAME = "管理者";

export const WELCOME_DEFAULTS: Record<Locale, { folderName: string; noteFilename: string }> = {
  ja: {
    folderName: DEFAULT_WELCOME_FOLDER_NAME,
    noteFilename: DEFAULT_WELCOME_NOTE_FILENAME,
  },
  en: {
    folderName: "Welcome",
    noteFilename: "01-Welcome.md",
  },
};
