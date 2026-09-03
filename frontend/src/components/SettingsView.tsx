import { ArrowLeft, Check, MoonStar, Settings2, Sun } from "lucide-react";
import { useLocale } from "../LocaleContext";
import { SUPPORTED_LOCALES } from "../locales";
import type { Theme } from "../theme";

type Props = {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
};

export function SettingsView({ theme, onTheme, onClose }: Props) {
  const { locale, setLocale, text: uiText } = useLocale();
  const themes = [
    { id: "light", ...uiText.settings.themes.light, Icon: Sun },
    { id: "dark", ...uiText.settings.themes.dark, Icon: MoonStar },
  ] satisfies Array<{ id: Theme; label: string; description: string; Icon: typeof Sun }>;

  return <>
    <header className="document-bar settings-document-bar">
      <div className="settings-breadcrumb"><Settings2 size={17} /><strong>{uiText.settings.breadcrumb}</strong><span>/</span><span>{uiText.settings.preferences}</span></div>
      <button className="secondary-button settings-back-button" onClick={onClose}><ArrowLeft size={16} /><span>{uiText.settings.backToNote}</span></button>
    </header>
    <div className="settings-scroll">
      <section className="settings-page" aria-labelledby="settings-title">
        <div className="settings-intro">
          <span>{uiText.settings.eyebrow}</span>
          <h1 id="settings-title">{uiText.settings.title}</h1>
          <p>{uiText.settings.description}</p>
        </div>
        <section className="settings-section" aria-labelledby="theme-heading">
          <div className="settings-section-heading">
            <div><h2 id="theme-heading">{uiText.settings.themeTitle}</h2><p>{uiText.settings.themeDescription}</p></div>
            <span>{uiText.settings.themes[theme].label}</span>
          </div>
          <div className="theme-options" role="radiogroup" aria-label={uiText.settings.themeGroupLabel}>
            {themes.map(({ id, label, description, Icon }) => {
              const selected = theme === id;
              return <button key={id} className={`theme-option ${selected ? "selected" : ""}`} role="radio" aria-checked={selected} onClick={() => onTheme(id)}>
                <span className={`theme-option-icon ${id}`}><Icon size={21} /></span>
                <span className="theme-option-copy"><strong>{label}</strong><small>{description}</small></span>
                <span className="theme-option-check" aria-hidden="true">{selected ? <Check size={16} /> : null}</span>
              </button>;
            })}
          </div>
        </section>
        <section className="settings-section" aria-labelledby="language-heading">
          <div className="settings-section-heading">
            <div><h2 id="language-heading">{uiText.settings.languageTitle}</h2><p>{uiText.settings.languageDescription}</p></div>
            <span>{uiText.settings.languages[locale].label}</span>
          </div>
          <div className="language-options" role="radiogroup" aria-label={uiText.settings.languageGroupLabel}>
            {SUPPORTED_LOCALES.map((id) => {
              const option = uiText.settings.languages[id];
              const selected = locale === id;
              return <button key={id} className={`language-option ${selected ? "selected" : ""}`} role="radio" aria-checked={selected} onClick={() => setLocale(id)}>
                <span className={`language-option-icon ${id}`}>{id.toUpperCase()}</span>
                <span className="theme-option-copy"><strong>{option.label}</strong><small>{option.description}</small></span>
                <span className="theme-option-check" aria-hidden="true">{selected ? <Check size={16} /> : null}</span>
              </button>;
            })}
          </div>
        </section>
      </section>
    </div>
    <footer className="statusbar settings-statusbar"><span className="settings-saved-status"><i />{uiText.settings.savedAutomatically}</span><span className="status-spacer" /><span>{uiText.settings.currentTheme(uiText.settings.themes[theme].label)}</span><b /><span>{uiText.settings.currentLanguage(uiText.settings.languages[locale].label)}</span></footer>
  </>;
}
