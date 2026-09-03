import type { ja } from "./ja";

type WidenLocale<T> = T extends (...args: infer Args) => string
  ? (...args: Args) => string
  : T extends string
    ? string
    : T extends object
      ? { [Key in keyof T]: WidenLocale<T[Key]> }
      : T;

export type UiText = WidenLocale<typeof ja>;
