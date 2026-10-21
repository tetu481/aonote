import { useState } from "react";
import { api, ApiError } from "../api";
import { useUiText } from "../LocaleContext";
import { Brand } from "./Brand";

export function LoginView({ onLogin }: { onLogin: () => void }) {
  const uiText = useUiText();
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return <main className="login-view"><form onSubmit={async (event) => {
    event.preventDefault();
    if (submitting) return;
    setError("");
    setSubmitting(true);
    try {
      await api.login(password);
      onLogin();
    } catch (error) {
      setError(error instanceof ApiError && error.status === 429
        ? uiText.login.rateLimited(Math.ceil((error.retryAfter ?? 900) / 60))
        : uiText.login.invalidPassword);
    } finally {
      setSubmitting(false);
    }
  }}>
    <Brand /><h1>{uiText.login.title}</h1><p>{uiText.login.description}</p>
    {error ? <div className="login-error" role="alert">{error}</div> : null}<label>{uiText.login.password}<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoFocus required /></label><button className="primary-button" disabled={submitting}>{uiText.login.submit}</button>
  </form></main>;
}
