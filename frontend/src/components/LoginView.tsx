import { useState } from "react";
import { api } from "../api";
import { useUiText } from "../LocaleContext";
import { Brand } from "./Brand";

export function LoginView({ onLogin }: { onLogin: () => void }) {
  const uiText = useUiText();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return <main className="login-view"><form onSubmit={async (event) => { event.preventDefault(); setError(""); try { await api.login(password); onLogin(); } catch { setError(uiText.login.invalidPassword); } }}>
    <Brand /><h1>{uiText.login.title}</h1><p>{uiText.login.description}</p>
    {error ? <div className="login-error">{error}</div> : null}<label>{uiText.login.password}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required /></label><button className="primary-button">{uiText.login.submit}</button>
  </form></main>;
}
