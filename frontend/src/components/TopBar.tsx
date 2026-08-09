import { FolderPlus, Menu, Plus, Search } from "lucide-react";
import { Brand } from "./Brand";

type Props = {
  onMenu: () => void;
  onSearch: () => void;
  onCreate: () => void;
  onCreateFolder: () => void;
  sidebarOpen: boolean;
};

export function TopBar({ onMenu, onSearch, onCreate, onCreateFolder, sidebarOpen }: Props) {
  return (
    <header className="topbar">
      <button className="icon-button menu-button" onClick={onMenu} aria-label={sidebarOpen ? "ワークスペースを隠す" : "ワークスペースを表示"} aria-pressed={sidebarOpen}><Menu size={20} /></button>
      <Brand />
      <button className="command-search" onClick={onSearch} aria-label="ノートを検索">
        <Search size={17} />
        <span>ノートを検索…</span>
        <kbd>⌘ K</kbd>
      </button>
      <div className="topbar-actions">
        <button className="secondary-button" onClick={onCreateFolder}><FolderPlus size={17} /><span>新規フォルダ</span></button>
        <button className="primary-button" onClick={onCreate}><Plus size={17} /><span>新規ノート</span></button>
      </div>
    </header>
  );
}
