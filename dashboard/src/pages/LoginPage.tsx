import { FormEvent, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { ApiError, getAdminToken, login } from "../api/client";

export function LoginPage() {
  const navigate = useNavigate();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (getAdminToken()) {
      navigate("/", { replace: true });
    }
  }, [navigate]);

  async function onSubmit(ev: FormEvent) {
    ev.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(password);
      navigate("/", { replace: true });
    } catch (e) {
      if (e instanceof ApiError) {
        setError(e.message || "Login failed");
      } else {
        setError("Login failed");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="layout narrow">
      <div className="card login-card">
        <div className="brand">
          <div className="logo" aria-hidden />
          <div>
            <h1>CloudTunnel Manager</h1>
            <p className="muted">Sign in with the admin password.</p>
          </div>
        </div>
        <form className="stack" onSubmit={onSubmit}>
          <label className="field">
            <span>Password</span>
            <input
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(ev) => setPassword(ev.target.value)}
              required
            />
          </label>
          {error ? <p className="error">{error}</p> : null}
          <button className="btn primary stretch" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </div>
  );
}
