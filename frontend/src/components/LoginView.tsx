import { useState } from "react";
import { api } from "../api";
import { Brand } from "./Brand";

export function LoginView({ onLogin }: { onLogin: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  return <main className="login-view"><form onSubmit={async (event) => { event.preventDefault(); setError(""); try { await api.login(password); onLogin(); } catch { setError("パスワードが正しくありません"); } }}>
    <Brand /><h1>ワークスペースを開く</h1><p>あなたのノートは非公開です。管理パスワードを入力してください。</p>
    {error ? <div className="login-error">{error}</div> : null}<label>管理パスワード<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required /></label><button className="primary-button">aonoteを開く</button>
  </form></main>;
}
