import { ArrowLeft, Check, MoonStar, Settings2, Sun } from "lucide-react";
import type { Theme } from "../theme";

type Props = {
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onClose: () => void;
};

const themes = [
  { id: "light", label: "ライト", description: "現在の明るく淡いブルーの表示", Icon: Sun },
  { id: "dark", label: "ダーク", description: "目に優しい深いブルーの表示", Icon: MoonStar },
] satisfies Array<{ id: Theme; label: string; description: string; Icon: typeof Sun }>;

export function SettingsView({ theme, onTheme, onClose }: Props) {
  return <>
    <header className="document-bar settings-document-bar">
      <div className="settings-breadcrumb"><Settings2 size={17} /><strong>設定</strong><span>/</span><span>外観</span></div>
      <button className="secondary-button settings-back-button" onClick={onClose}><ArrowLeft size={16} /><span>ノートに戻る</span></button>
    </header>
    <div className="settings-scroll">
      <section className="settings-page" aria-labelledby="settings-title">
        <div className="settings-intro">
          <span>SETTINGS</span>
          <h1 id="settings-title">外観</h1>
          <p>使いやすい表示テーマを選択できます。設定はこのブラウザに保存されます。</p>
        </div>
        <section className="settings-section" aria-labelledby="theme-heading">
          <div className="settings-section-heading">
            <div><h2 id="theme-heading">テーマ</h2><p>aonote全体のカラーテーマを切り替えます。</p></div>
            <span>{theme === "light" ? "ライト" : "ダーク"}</span>
          </div>
          <div className="theme-options" role="radiogroup" aria-label="画面テーマ">
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
      </section>
    </div>
    <footer className="statusbar settings-statusbar"><span className="settings-saved-status"><i />設定は自動的に保存されます</span><span className="status-spacer" /><span>テーマ: {theme === "light" ? "ライト" : "ダーク"}</span></footer>
  </>;
}
