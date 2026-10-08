import { useEffect, useState, type FormEvent } from 'react';
import { MapPin, Pencil, Plus, X } from 'lucide-react';
import { api, patch, post, type Branch } from './api';
import './branches.css';

type FormState = { name: string; code: string; phone: string; email: string; addressLine1: string; addressLine2: string; city: string; state: string; postalCode: string; country: string; timezone: string; openingTime: string; closingTime: string };
const blank: FormState = { name: '', code: '', phone: '', email: '', addressLine1: '', addressLine2: '', city: '', state: '', postalCode: '', country: 'IN', timezone: 'Asia/Kolkata', openingTime: '', closingTime: '' };
const fields: { key: keyof FormState; label: string; required?: boolean; type?: string }[] = [
  { key: 'name', label: 'Branch name', required: true }, { key: 'code', label: 'Code (optional)' }, { key: 'phone', label: 'Phone', required: true, type: 'tel' }, { key: 'email', label: 'Email (optional)', type: 'email' },
  { key: 'addressLine1', label: 'Address', required: true }, { key: 'addressLine2', label: 'Address line 2 (optional)' }, { key: 'city', label: 'City', required: true }, { key: 'state', label: 'State', required: true },
  { key: 'postalCode', label: 'Postal code', required: true }, { key: 'country', label: 'Country', required: true }, { key: 'timezone', label: 'Timezone', required: true },
  { key: 'openingTime', label: 'Opening time', type: 'time' }, { key: 'closingTime', label: 'Closing time', type: 'time' },
];
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Request failed';

export function BranchesView() {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [editing, setEditing] = useState<Branch | 'new' | null>(null);
  const [form, setForm] = useState<FormState>(blank);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function refresh() { setBranches(await api<Branch[]>('/branches')); }
  useEffect(() => { void api<Branch[]>('/branches').then(setBranches).catch((cause) => setError(errorText(cause))); }, []);

  function open(branch: Branch | 'new') {
    setEditing(branch); setError('');
    setForm(branch === 'new' ? blank : { name: branch.name, code: branch.code ?? '', phone: branch.phone ?? '', email: branch.email ?? '', addressLine1: branch.addressLine1 ?? branch.address ?? '', addressLine2: branch.addressLine2 ?? '', city: branch.city ?? '', state: branch.state ?? '', postalCode: branch.postalCode ?? '', country: branch.country ?? 'IN', timezone: branch.timezone ?? 'Asia/Kolkata', openingTime: branch.openingTime ?? '', closingTime: branch.closingTime ?? '' });
  }
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    const input = { ...form };
    try { if (editing === 'new') await post('/branches', input); else if (editing) await patch(`/branches/${editing.id}`, input); await refresh(); setEditing(null); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function toggle(branch: Branch) {
    if (branch.active && !window.confirm(`Deactivate ${branch.name}? Existing jobs and history will remain available, but new check-ins will stop.`)) return;
    setBusy(true); setError('');
    try { await post(`/branches/${branch.id}/${branch.active ? 'deactivate' : 'activate'}`, {}); await refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <div className="branches-page">
    <div className="branches-toolbar"><div><h2>Branches</h2><p>Locations for this business</p></div><button type="button" className="btn primary" onClick={() => open('new')}><Plus size={18} />Add Branch</button></div>
    {error && <p className="portal-error" role="alert">{error}</p>}
    <div className="branches-grid">{branches.map((branch) => <article className="branch-card" key={branch.id}>
      <div className="branch-card-head"><div><h3>{branch.name}</h3>{branch.code && <small>{branch.code}</small>}</div><span className={`status-pill ${branch.active ? 'is-active' : ''}`}>{branch.active ? 'Active' : 'Inactive'}</span></div>
      <p className="branch-location"><MapPin size={16} />{branch.city && branch.state ? `${branch.city}, ${branch.state}` : branch.address || 'Location not set'}</p>
      <p>{branch.phone || 'No phone set'}</p><div className="branch-stats"><span><b>{branch.employeeCount ?? 0}</b> employees</span><span><b>{branch.activeJobCount ?? 0}</b> active jobs</span><span><b>{branch.todayJobCount ?? 0}</b> today</span></div>
      <div className="branch-actions"><button type="button" className="btn ghost" onClick={() => open(branch)}><Pencil size={16} />View / Edit</button><button type="button" className="btn ghost" disabled={busy} onClick={() => void toggle(branch)}>{branch.active ? 'Deactivate' : 'Activate'}</button></div>
    </article>)}{!branches.length && <div className="empty">No branches found.</div>}</div>
    {editing && <div className="sheet-backdrop" onClick={() => setEditing(null)}><section className="branch-sheet" role="dialog" aria-modal="true" aria-label={editing === 'new' ? 'Add branch' : 'Edit branch'} onClick={(event) => event.stopPropagation()}><header><h2>{editing === 'new' ? 'Add Branch' : 'Edit Branch'}</h2><button type="button" className="icon-btn" aria-label="Close" onClick={() => setEditing(null)}><X size={20} /></button></header><form onSubmit={(event) => void save(event)}><div className="branch-form-grid">{fields.map((field) => <label className="field" key={field.key}><span>{field.label}</span><input className="input" type={field.type ?? 'text'} required={field.required} value={form[field.key]} onChange={(event) => setForm((current) => ({ ...current, [field.key]: event.target.value }))} /></label>)}</div>{error && <p className="portal-error" role="alert">{error}</p>}<button className="btn primary" disabled={busy}>{editing === 'new' ? 'Create branch' : 'Save changes'}</button></form></section></div>}
  </div>;
}
