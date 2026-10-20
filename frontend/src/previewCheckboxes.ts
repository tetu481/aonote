export const PREVIEW_CHECKBOX_MODES = ["readonly", "toggle", "toggle-strikethrough"] as const;
export type PreviewCheckboxMode = (typeof PREVIEW_CHECKBOX_MODES)[number];
export const PREVIEW_CHECKBOX_STORAGE_KEY = "aonote:preview-checkboxes:v1";

export function readStoredPreviewCheckboxMode(): PreviewCheckboxMode {
  try {
    const value = window.localStorage.getItem(PREVIEW_CHECKBOX_STORAGE_KEY);
    return PREVIEW_CHECKBOX_MODES.includes(value as PreviewCheckboxMode) ? value as PreviewCheckboxMode : "readonly";
  } catch {
    return "readonly";
  }
}

export function persistPreviewCheckboxMode(mode: PreviewCheckboxMode) {
  try { window.localStorage.setItem(PREVIEW_CHECKBOX_STORAGE_KEY, mode); }
  catch { /* Keep the preference for this session if storage is unavailable. */ }
}

export function toggleTaskCheckbox(content: string, offset: number, checked: boolean) {
  if (!Number.isInteger(offset) || offset < 1 || content[offset - 1] !== "[" || content[offset + 1] !== "]" || !/[ xX]/.test(content[offset] ?? "")) return content;
  return content.slice(0, offset) + (checked ? "x" : " ") + content.slice(offset + 1);
}
