import { FolderPlus, Menu, Plus, Search } from "lucide-react";
import { uiText } from "../locales";
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
      <button className="icon-button menu-button" onClick={onMenu} aria-label={sidebarOpen ? uiText.topBar.hideWorkspace : uiText.topBar.showWorkspace} aria-pressed={sidebarOpen}><Menu size={20} /></button>
      <Brand />
      <button className="command-search" onClick={onSearch} aria-label={uiText.topBar.searchLabel}>
        <Search size={17} />
        <span>{uiText.topBar.searchPlaceholder}</span>
        <kbd>{uiText.topBar.searchShortcut}</kbd>
      </button>
      <div className="topbar-actions">
        <button className="secondary-button" onClick={onCreateFolder}><FolderPlus size={17} /><span>{uiText.topBar.newFolder}</span></button>
        <button className="primary-button" onClick={onCreate}><Plus size={17} /><span>{uiText.topBar.newNote}</span></button>
      </div>
    </header>
  );
}
