import { useState, type FormEvent } from 'react';
import { post } from './api';

export function OwnerSetupView({ token, onComplete }: { token: string; onComplete: () => void }) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault(); setError('');
    if (password !== confirm) { setError('Passwords do not match'); return; }
    setBusy(true);
    try { await post('/auth/owner/setup', { token, password }); onComplete(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not set password'); }
    finally { setBusy(false); }
  }

  return <div className="login-page"><div className="login-wrap"><div className="login-box owner-setup-form"><h1>Set your owner password</h1><p>Choose a password of at least 14 characters to activate your account.</p><form onSubmit={submit}><label className="field"><span>New password</span><input className="input" type="password" autoComplete="new-password" minLength={14} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} required /></label><label className="field"><span>Confirm password</span><input className="input" type="password" autoComplete="new-password" minLength={14} maxLength={128} value={confirm} onChange={(event) => setConfirm(event.target.value)} required /></label><button className="btn primary block" disabled={busy}>Set password</button></form>{error && <div className="login-error" role="alert">{error}</div>}</div></div></div>;
}
