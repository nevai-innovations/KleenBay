import { useEffect, useState, type FormEvent } from 'react';
import { api, patch, post, type WhatsAppSettings } from './api';

const fields: { key: 'templateReceived' | 'templateWashing' | 'templateReady' | 'templateHandedOver'; label: string }[] = [
  { key: 'templateReceived', label: 'Vehicle received' },
  { key: 'templateWashing', label: 'Wash started' },
  { key: 'templateReady', label: 'Ready for pickup' },
  { key: 'templateHandedOver', label: 'Handover (optional)' },
];

export function WhatsAppSettingsView() {
  const [settings, setSettings] = useState<WhatsAppSettings | null>(null);
  const [draft, setDraft] = useState<WhatsAppSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState('');

  useEffect(() => {
    void api<WhatsAppSettings>('/whatsapp/settings').then((value) => { setSettings(value); setDraft(value); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load WhatsApp settings'));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setBusy(true); setError(''); setResult('');
    try {
      const updated = await patch<WhatsAppSettings>('/whatsapp/settings', {
        enabled: draft.enabled,
        senderNumber: draft.senderNumber || null,
        senderDisplayName: draft.senderDisplayName || null,
        templateReceived: draft.templateReceived,
        templateWashing: draft.templateWashing,
        templateReady: draft.templateReady,
        templateHandedOver: draft.templateHandedOver || null,
      });
      setSettings(updated); setDraft(updated); setResult('WhatsApp settings saved.');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save settings'); }
    finally { setBusy(false); }
  }

  async function testConnection() {
    setBusy(true); setError(''); setResult('');
    try { const response = await post<{ message: string }>('/whatsapp/test-connection', {}); setResult(response.message); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Connection test failed'); }
    finally { setBusy(false); }
  }

  return <section className="ops-settings" aria-label="WhatsApp settings">
    <h2>WhatsApp</h2>
    {!draft ? <p className="ops-loading">Loading settings...</p> : <>
      <p className="wa-provider-state"><strong>{settings?.provider}</strong> · {settings?.status.replaceAll('_', ' ')}</p>
      {settings?.provider === 'MOCK' && <p className="wa-mock-note">Mock provider active — no real WhatsApp messages are being sent.</p>}
      <form onSubmit={(event) => void save(event)} className="wa-settings-form">
        <label className="ops-setting-row"><span>Automatic customer updates</span><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} /></label>
        <div className="wa-settings-fields">
          <label className="field"><span>Connected sender number</span><input className="input" type="tel" inputMode="tel" placeholder="Not connected" value={draft.senderNumber ?? ''} disabled={busy} onChange={(event) => setDraft({ ...draft, senderNumber: event.target.value })} /></label>
          <label className="field"><span>Sender display name</span><input className="input" value={draft.senderDisplayName ?? ''} disabled={busy} onChange={(event) => setDraft({ ...draft, senderDisplayName: event.target.value })} /></label>
        </div>
        <h3>Message templates</h3>
        <div className="wa-settings-fields">{fields.map(({ key, label }) => <label className="field" key={key}><span>{label}</span><input className="input" value={draft[key] ?? ''} disabled={busy} required={key !== 'templateHandedOver'} onChange={(event) => setDraft({ ...draft, [key]: event.target.value })} /></label>)}</div>
        <div className="wa-settings-actions"><button className="btn primary" disabled={busy} type="submit">Save settings</button><button className="btn ghost" disabled={busy} type="button" onClick={() => void testConnection()}>Test connection</button></div>
      </form>
    </>}
    {result && <p role="status">{result}</p>}{error && <p className="portal-error" role="alert">{error}</p>}
  </section>;
}
