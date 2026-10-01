import { useCallback, useEffect, useState, type DragEvent, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Check, MessageCircle, Plus, RotateCcw, Search, X } from 'lucide-react';
import { canMoveStage, stageLabels, type Stage } from '@carwash/shared';
import { api, patch, post, upload, type AvailableEmployee, type BoardMetrics, type Branch, type Customer, type Job, type JobStage, type OperationCapabilities, type OperationSettings, type Service, type Session, type Vehicle } from './api';

const activeStages: JobStage[] = ['RECEIVED', 'WASHING', 'READY'];
const stageTone: Record<JobStage, string> = { RECEIVED: 'var(--st-0)', WASHING: 'var(--st-2)', READY: 'var(--st-4)', HANDED_OVER: 'var(--st-4)' };
const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(paise / 100);
const clock = (value: string) => new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(value));
const dateTime = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : 'Request failed';
const plateKey = (value: string) => value.toUpperCase().replace(/[^A-Z0-9]/g, '');
const messageLabel = (event: string) => ({ VEHICLE_RECEIVED: 'Vehicle received message', WASH_STARTED: 'Wash started message', VEHICLE_READY: 'Ready for pickup message', VEHICLE_HANDED_OVER: 'Handover message' })[event as 'VEHICLE_RECEIVED' | 'WASH_STARTED' | 'VEHICLE_READY' | 'VEHICLE_HANDED_OVER'] ?? event.replaceAll('_', ' ');
const messageStatus = (message: NonNullable<Job['messages']>[number]) => message.status === 'SENT' ? message.providerMessageId?.startsWith('local:') ? 'Simulated' : 'Sent' : message.status === 'FAILED' ? 'Failed' : 'Pending';

function jobTimeline(job: Job) {
  const entries = [
    ...(job.stages ?? []).map((entry) => ({ id: entry.id, at: entry.createdAt, title: entry.fromStage ? stageLabels[entry.toStage as Stage] : 'Vehicle checked in', detail: `by ${entry.actor.name}${entry.note ? ` · ${entry.note}` : ''}` })),
    ...(job.messages ?? []).map((message) => ({ id: message.id, at: message.sentAt ?? message.failedAt ?? message.createdAt, title: messageLabel(message.event), detail: messageStatus(message) })),
    ...(job.invoice?.payments ?? []).map((payment) => ({ id: payment.id, at: payment.createdAt, title: `Payment ${money(payment.amountPaise)}`, detail: `${payment.method.replaceAll('_', ' ')} · ${payment.collectedBy.name}` })),
  ];
  return entries.sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return <div className="ops-overlay" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="ops-sheet" role="dialog" aria-modal="true" aria-label={title}>
      <header className="ops-sheet-head"><h2>{title}</h2><button type="button" className="icon-btn" onClick={onClose} aria-label="Close" title="Close"><X size={20} /></button></header>
      <div className="ops-sheet-body">{children}</div>
    </section>
  </div>;
}

function CheckInSheet({ session, branches, services, employees, onClose, onSaved }: {
  session: Session; branches: Branch[]; services: Service[]; employees: AvailableEmployee[]; onClose: () => void; onSaved: (job: Job) => void;
}) {
  const [idempotencyKey] = useState(() => crypto.randomUUID());
  const [branchId, setBranchId] = useState(session.user.branchId ?? branches[0]?.id ?? '');
  const [mobile, setMobile] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [make, setMake] = useState('');
  const [model, setModel] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [expectedAt, setExpectedAt] = useState(() => new Date(Date.now() + 90 * 60_000 - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16));
  const [notes, setNotes] = useState('');
  const [notify, setNotify] = useState(true);
  const [employeeIds, setEmployeeIds] = useState<string[]>([]);
  const [knownCustomer, setKnownCustomer] = useState<Customer | null>(null);
  const [knownVehicle, setKnownVehicle] = useState<Vehicle | null>(null);
  const [pastVisits, setPastVisits] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const mobileDigits = mobile.replace(/\D/g, '').slice(-10);
  const selectedBranchEmployees = employees.filter((employee) => !employee.branchId || employee.branchId === branchId);

  useEffect(() => {
    if (mobileDigits.length !== 10) return;
    let active = true;
    void api<Customer[]>(`/customers?q=${encodeURIComponent(mobileDigits)}`).then((list) => {
      if (!active) return;
      const found = list.find((item) => item.mobile.endsWith(mobileDigits)) ?? null;
      setKnownCustomer(found);
      if (found) setCustomerName(found.name);
    }).catch(() => {});
    return () => { active = false; };
  }, [mobileDigits]);

  useEffect(() => {
    const plate = plateKey(registrationNumber);
    if (plate.length < 6) return;
    let active = true;
    void api<Vehicle[]>(`/vehicles?q=${encodeURIComponent(plate)}`).then(async (list) => {
      const found = list.find((item) => item.registrationNumber === plate) ?? null;
      if (!active) return;
      setKnownVehicle(found);
      if (found) {
        setMake(found.make); setModel(found.model); setVehicleType(found.type);
        const past = await api<Job[]>(`/jobs?view=history&vehicleId=${encodeURIComponent(found.id)}`);
        if (active) setPastVisits(past.length);
      } else setPastVisits(0);
    }).catch(() => {});
    return () => { active = false; };
  }, [registrationNumber]);

  async function submit(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const job = await post<Job>('/jobs/check-in', { idempotencyKey, branchId, mobile, customerName, registrationNumber, make, model, vehicleType, serviceId, expectedAt: new Date(expectedAt).toISOString(), notes, notify, ...(session.user.role === 'OWNER' ? { employeeIds } : {}) });
      onSaved(job);
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }

  const mismatch = knownVehicle?.customer && mobileDigits.length === 10 && !knownVehicle.customer.mobile.endsWith(mobileDigits);
  return <Sheet title="Check-in Vehicle" onClose={onClose}>
    <form className="ops-form" onSubmit={(event) => void submit(event)}>
      {branches.length > 1 && <label className="field"><span>Branch</span><select className="input" value={branchId} onChange={(event) => { setBranchId(event.target.value); setEmployeeIds([]); }} required>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select></label>}
      <div className="ops-form-grid"><label className="field"><span>Customer mobile number</span><input className="input" type="tel" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => { setMobile(event.target.value); setCustomerName(''); setKnownCustomer(null); }} required /></label>
        <label className="field"><span>Customer name</span><input className="input" autoComplete="name" value={customerName} onChange={(event) => setCustomerName(event.target.value)} required /></label></div>
      {knownCustomer && <p className="ops-match"><Check size={16} /> Existing customer: {knownCustomer.name}</p>}
      <div className="ops-form-grid"><label className="field"><span>Vehicle registration number</span><input className="input" autoCapitalize="characters" value={registrationNumber} onChange={(event) => { setRegistrationNumber(event.target.value); setMake(''); setModel(''); setVehicleType(''); setKnownVehicle(null); setPastVisits(0); }} required /></label>
        <label className="field"><span>Vehicle type</span><select className="input" value={vehicleType} onChange={(event) => setVehicleType(event.target.value)} required><option value="">Select type</option>{['HATCHBACK', 'SEDAN', 'SUV', 'MUV', 'TWO_WHEELER', 'COMMERCIAL', 'OTHER'].map((type) => <option key={type} value={type}>{type.replaceAll('_', ' ')}</option>)}</select></label></div>
      {knownVehicle && <p className={`ops-match${mismatch ? ' is-warning' : ''}`}>{mismatch ? `This vehicle belongs to ${knownVehicle.customer?.name}. Check the mobile number.` : `Existing vehicle found. ${pastVisits} previous ${pastVisits === 1 ? 'visit' : 'visits'}.`}</p>}
      <div className="ops-form-grid"><label className="field"><span>Make</span><input className="input" value={make} onChange={(event) => setMake(event.target.value)} required /></label><label className="field"><span>Model</span><input className="input" value={model} onChange={(event) => setModel(event.target.value)} required /></label></div>
      <div className="ops-form-grid"><label className="field"><span>Wash service</span><select className="input" value={serviceId} onChange={(event) => setServiceId(event.target.value)} required><option value="">Select service</option>{services.filter((service) => service.active).map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select></label>
        <label className="field"><span>Expected completion</span><input className="input" type="datetime-local" value={expectedAt} onChange={(event) => setExpectedAt(event.target.value)} required /></label></div>
      <label className="field"><span>Notes (optional)</span><textarea className="input ops-textarea" value={notes} onChange={(event) => setNotes(event.target.value)} rows={2} /></label>
      {session.user.role === 'OWNER' && selectedBranchEmployees.length > 0 && <fieldset className="ops-fieldset"><legend>Assign employees (optional)</legend><div className="ops-checks">{selectedBranchEmployees.map((employee) => <label key={employee.id}><input type="checkbox" checked={employeeIds.includes(employee.id)} onChange={(event) => setEmployeeIds(event.target.checked ? [...employeeIds, employee.id] : employeeIds.filter((id) => id !== employee.id))} />{employee.name}</label>)}</div></fieldset>}
      <label className="ops-toggle"><input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} /> Send vehicle status messages</label>
      {error && <p className="portal-error" role="alert">{error}</p>}
      <button className="btn primary block" disabled={busy || !!mismatch}><Plus size={18} />Check-in Vehicle</button>
    </form>
  </Sheet>;
}

function JobCard({ job, onOpen, onAdvance, onHandover, busy, canHandover, late }: { job: Job; onOpen: () => void; onAdvance: () => void; onHandover: () => void; busy: boolean; canHandover: boolean; late: boolean }) {
  const action = job.status === 'RECEIVED' ? 'Start Washing' : job.status === 'WASHING' ? 'Mark Ready' : 'Handover';
  function dragStart(event: DragEvent<HTMLElement>) { event.dataTransfer.setData('text/plain', job.id); event.dataTransfer.effectAllowed = 'move'; }
  return <article className={`job${late ? ' is-late' : ''}`} style={{ '--stage': stageTone[job.status] } as React.CSSProperties} draggable={job.status !== 'READY'} onDragStart={dragStart} data-job-id={job.id}>
    <button type="button" className="job-open" onClick={onOpen}><strong className="plate">{job.vehicle.registrationNumber}</strong><span className="job-sub">{job.vehicle.make} {job.vehicle.model} · {job.customer.name}</span><span className="job-foot"><span className="job-svc">{job.serviceName}</span><span className={`age${late ? ' late' : job.status === 'READY' ? ' ready' : ''}`}>{late ? `Late · expected ${clock(job.expectedAt)}` : `Expected ${clock(job.expectedAt)}`}</span></span></button>
    <div className="track" aria-hidden="true">{activeStages.map((stage, index) => <i key={stage} className={index <= activeStages.indexOf(job.status) ? 'on' : ''} />)}</div>
    {job.status === 'READY' && !canHandover ? <div className="ops-card-note">Owner handover required</div> : <button type="button" className={`act${job.status === 'READY' ? ' final' : ''}`} disabled={busy} onClick={job.status === 'READY' ? onHandover : onAdvance}><span>{action}</span><ArrowRight size={18} /></button>}
  </article>;
}

function HandoverSheet({ jobId, capabilities, onClose, onSaved }: { jobId: string; capabilities: OperationCapabilities; onClose: () => void; onSaved: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('UPI');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void api<Job>(`/jobs/${jobId}`).then((item) => { setJob(item); setAmount(((item.outstandingPaise ?? item.totalPaise ?? 0) / 100).toFixed(2)); }).catch((cause) => setError(errorText(cause))); }, [jobId]);
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!job) return; setBusy(true); setError('');
    try {
      await post(`/jobs/${job.id}/handover`, { paymentAmountPaise: Math.round(Number(amount) * 100), ...(Number(amount) > 0 ? { paymentMethod: method } : {}), notes });
      onSaved();
    } catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <Sheet title="Handover" onClose={onClose}>{job && <form className="ops-form" onSubmit={(event) => void submit(event)}>
    <div className="ops-handover-summary"><strong className="plate">{job.vehicle.registrationNumber}</strong><span>{job.vehicle.make} {job.vehicle.model} · {job.customer.name}</span><span>{job.serviceName}</span></div>
    <div className="ops-bill-row"><span>Total</span><strong>{money(job.totalPaise ?? 0)}</strong></div><div className="ops-bill-row"><span>Payment status</span><strong>{job.paymentStatus === 'PAID' ? 'Paid' : job.paymentStatus === 'PARTIALLY_PAID' ? 'Partially paid' : 'Unpaid'}</strong></div><div className="ops-bill-row"><span>Outstanding</span><strong>{money(job.outstandingPaise ?? job.totalPaise ?? 0)}</strong></div>
    <div className="ops-form-grid"><label className="field"><span>Collect now (INR)</span><input className="input" type="number" inputMode="decimal" min={capabilities.allowOutstanding ? '0' : String((job.totalPaise ?? 0) / 100)} max={String((job.outstandingPaise ?? job.totalPaise ?? 0) / 100)} step="0.01" value={amount} onChange={(event) => setAmount(event.target.value)} required /></label><label className="field"><span>Payment method</span><select className="input" value={method} onChange={(event) => setMethod(event.target.value)} disabled={Number(amount) === 0}>{['UPI', 'CASH', 'CARD', 'BANK_TRANSFER', 'OTHER'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select></label></div>
    <label className="field"><span>Handover notes (optional)</span><textarea className="input ops-textarea" rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} /></label>
    {error && <p className="portal-error" role="alert">{error}</p>}
    <button className="btn primary block" disabled={busy || !Number.isFinite(Number(amount))}><Check size={18} />Confirm Handover</button>
  </form>}{!job && <p className="ops-loading">{error || 'Loading vehicle...'}</p>}</Sheet>;
}

function JobDetail({ jobId, role, onClose, onChanged }: { jobId: string; role: Session['user']['role']; onClose: () => void; onChanged: () => void }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [correcting, setCorrecting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const [damages, setDamages] = useState<{ location: string; type: string; description: string }[]>([]);
  const [photoKind, setPhotoKind] = useState('BEFORE');
  const [photoDescription, setPhotoDescription] = useState('');
  const [damageItemId, setDamageItemId] = useState('');
  const [photoFile, setPhotoFile] = useState<File | null>(null);
  const refresh = useCallback(() => { void api<Job>(`/jobs/${jobId}`).then(setJob).catch((cause) => setError(errorText(cause))); }, [jobId]);
  useEffect(() => { refresh(); const timer = setInterval(refresh, 5000); return () => clearInterval(timer); }, [refresh]);
  async function retry(messageId: string) {
    setBusy(true); setError('');
    try { await post(`/jobs/${jobId}/messages/${messageId}/retry`, {}); refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function correct(event: FormEvent) {
    event.preventDefault(); if (!job) return;
    const prior = job.status === 'READY' ? 'WASHING' : 'RECEIVED';
    setBusy(true); setError('');
    try { await post(`/jobs/${job.id}/correct-stage`, { to: prior, reason }); setCorrecting(false); setReason(''); refresh(); onChanged(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function finalizeInspection(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await post(`/jobs/${jobId}/inspection`, { damages }); setRecording(false); refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  async function addPhoto(event: FormEvent) {
    event.preventDefault(); if (!photoFile) return; setBusy(true); setError('');
    const params = new URLSearchParams({ kind: photoKind });
    if (photoDescription) params.set('description', photoDescription);
    if (photoKind === 'DAMAGE' && damageItemId) params.set('damageItemId', damageItemId);
    try { await upload(`/jobs/${jobId}/photos?${params}`, photoFile); setPhotoFile(null); setPhotoDescription(''); setDamageItemId(''); refresh(); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  return <Sheet title="Vehicle details" onClose={onClose}>{job ? <div className="ops-detail">
    <div className="ops-detail-hero"><strong className="plate">{job.vehicle.registrationNumber}</strong><span className="stage-pill" style={{ '--stage': stageTone[job.status] } as React.CSSProperties}>{stageLabels[job.status as Stage]}</span><p>{job.vehicle.make} {job.vehicle.model} · {job.customer.name}</p><small>{job.serviceName} · {job.branch.name}</small></div>
    <dl className="ops-facts"><div><dt>Check-in</dt><dd>{dateTime(job.checkedInAt)} by {job.checkedInBy?.name}</dd></div><div><dt>Expected</dt><dd>{dateTime(job.expectedAt)}</dd></div><div><dt>Mobile</dt><dd>{job.customer.mobile}</dd></div>{job.handedOverAt && <div><dt>Handover</dt><dd>{dateTime(job.handedOverAt)} by {job.handedOverBy?.name}</dd></div>}</dl>
    {job.notes && <div className="ops-detail-section"><h3>Notes</h3><p>{job.notes}</p></div>}
    <div className="ops-detail-section"><h3>Timeline</h3><ol className="ops-timeline">{jobTimeline(job).map((entry) => <li key={entry.id}><time>{dateTime(entry.at)}</time><strong>{entry.title}</strong><span>{entry.detail}</span></li>)}</ol></div>
    <div className="ops-detail-section"><h3>Employees</h3><p>{job.assignments?.filter((assignment) => !assignment.removedAt).map((assignment) => assignment.employee.name).join(', ') || 'Not assigned'}</p></div>
    <div className="ops-detail-section"><h3>Vehicle condition</h3>{job.inspection ? <><p>Finalized {dateTime(job.inspection.finalizedAt)} by {job.inspection.recordedBy.name}</p>{job.inspection.damages.length ? <ul className="ops-damage-list">{job.inspection.damages.map((damage) => <li key={damage.id}><strong>{damage.location.replaceAll('_', ' ')} · {damage.type.replaceAll('_', ' ')}</strong>{damage.description && <span>{damage.description}</span>}</li>)}</ul> : <p>No damage noted.</p>}</> : job.status !== 'HANDED_OVER' ? <>{!recording ? <button className="btn ghost" onClick={() => setRecording(true)}>Record condition</button> : <form className="ops-inspection-form" onSubmit={(event) => void finalizeInspection(event)}><p>Record existing damage before the wash. Finalizing locks this record.</p>{damages.map((damage, index) => <div className="ops-damage-entry" key={index}><select className="input" aria-label={`Damage ${index + 1} location`} value={damage.location} onChange={(event) => setDamages(damages.map((item, itemIndex) => itemIndex === index ? { ...item, location: event.target.value } : item))}>{['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR', 'WINDSHIELD', 'WHEELS', 'OTHER'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select><select className="input" aria-label={`Damage ${index + 1} type`} value={damage.type} onChange={(event) => setDamages(damages.map((item, itemIndex) => itemIndex === index ? { ...item, type: event.target.value } : item))}>{['SCRATCH', 'DENT', 'CRACK', 'PAINT_DAMAGE', 'BROKEN_ITEM', 'INTERIOR_DAMAGE', 'OTHER'].map((value) => <option key={value} value={value}>{value.replaceAll('_', ' ')}</option>)}</select><input className="input" aria-label={`Damage ${index + 1} description`} placeholder="Description (optional)" value={damage.description} onChange={(event) => setDamages(damages.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))} /><button type="button" className="text-action" onClick={() => setDamages(damages.filter((_, itemIndex) => itemIndex !== index))}>Remove</button></div>)}<div className="ops-inline-actions"><button type="button" className="btn ghost" onClick={() => setDamages([...damages, { location: 'FRONT', type: 'SCRATCH', description: '' }])}><Plus size={16} />Add damage</button><button className="btn primary" disabled={busy}>Finalize condition</button></div></form>}</> : <p>No condition record was captured.</p>}</div>
    <div className="ops-detail-section"><h3>Photos</h3>{job.photos?.length ? <div className="ops-photo-grid">{job.photos.map((photo) => <a href={`/api/photos/${photo.id}`} target="_blank" rel="noreferrer" key={photo.id} aria-label={`${photo.kind.toLowerCase()} photo uploaded by ${photo.uploadedBy.name}`}><img src={`/api/photos/${photo.id}`} alt={photo.description || `${photo.kind.toLowerCase()} view of ${job.vehicle.registrationNumber}`} /><span>{photo.kind.toLowerCase()} · {photo.uploadedBy.name}</span></a>)}</div> : <p>No photos captured.</p>}{job.status !== 'HANDED_OVER' && <form className="ops-photo-form" onSubmit={(event) => void addPhoto(event)}><label className="field"><span>Photo type</span><select className="input" value={photoKind} onChange={(event) => { setPhotoKind(event.target.value); setDamageItemId(''); }}>{['BEFORE', 'DURING', 'AFTER', 'DAMAGE'].map((kind) => <option key={kind} value={kind}>{kind}</option>)}</select></label>{photoKind === 'DAMAGE' && !!job.inspection?.damages.length && <label className="field"><span>Damage item (optional)</span><select className="input" value={damageItemId} onChange={(event) => setDamageItemId(event.target.value)}><option value="">General damage photo</option>{job.inspection.damages.map((item) => <option key={item.id} value={item.id}>{item.location} · {item.type}</option>)}</select></label>}<label className="field"><span>Photo</span><input className="input" type="file" accept="image/jpeg,image/png,image/webp" onChange={(event) => setPhotoFile(event.target.files?.[0] ?? null)} required /></label><label className="field"><span>Description (optional)</span><input className="input" value={photoDescription} onChange={(event) => setPhotoDescription(event.target.value)} /></label><button className="btn ghost" disabled={busy || !photoFile}>Upload photo</button></form>}</div>
    <div className="ops-detail-section"><h3>Messages</h3>{job.messages?.length ? <ul className="ops-message-list">{job.messages.map((message) => <li key={message.id}><MessageCircle size={17} /><span><strong>{messageLabel(message.event)}</strong><small>{clock(message.sentAt ?? message.failedAt ?? message.createdAt)} · {messageStatus(message)}</small></span>{message.status === 'FAILED' && role === 'OWNER' && <button className="text-action" disabled={busy} onClick={() => void retry(message.id)}><RotateCcw size={15} />Retry</button>}</li>)}</ul> : <p>No messages for this vehicle.</p>}</div>
    {job.invoice && <div className="ops-detail-section"><h3>Invoice {job.invoice.invoiceNumber}</h3><div className="ops-bill-row"><span>Total</span><strong>{money(job.invoice.totalPaise)}</strong></div><div className="ops-bill-row"><span>Paid</span><strong>{money(job.paidPaise ?? 0)}</strong></div><div className="ops-bill-row"><span>Outstanding</span><strong>{money(job.outstandingPaise ?? 0)}</strong></div></div>}
    {job.handoverNotes && <div className="ops-detail-section"><h3>Handover notes</h3><p>{job.handoverNotes}</p></div>}
    {role === 'OWNER' && ['WASHING', 'READY'].includes(job.status) && <div className="ops-detail-section"><button className="btn ghost" onClick={() => setCorrecting(!correcting)}>Correct stage</button>{correcting && <form className="ops-correction" onSubmit={(event) => void correct(event)}><p>Move back to {stageLabels[job.status === 'READY' ? 'WASHING' : 'RECEIVED']}?</p><label className="field"><span>Reason</span><textarea className="input ops-textarea" value={reason} onChange={(event) => setReason(event.target.value)} minLength={5} required /></label><button className="btn primary" disabled={busy}>Confirm correction</button></form>}</div>}
    {error && <p className="portal-error" role="alert">{error}</p>}
  </div> : <p className="ops-loading">{error || 'Loading vehicle...'}</p>}</Sheet>;
}

export function BoardView({ session }: { session: Session }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [metrics, setMetrics] = useState<BoardMetrics | null>(null);
  const [services, setServices] = useState<Service[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [employees, setEmployees] = useState<AvailableEmployee[]>([]);
  const [capabilities, setCapabilities] = useState<OperationCapabilities>({ allowOutstanding: true, canHandover: false });
  const [query, setQuery] = useState('');
  const [branchId, setBranchId] = useState('');
  const [mobileStage, setMobileStage] = useState<JobStage>('RECEIVED');
  const [checkInOpen, setCheckInOpen] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [handoverId, setHandoverId] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<JobStage | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const load = useCallback(async () => {
    const params = new URLSearchParams({ view: 'active' });
    if (query) params.set('q', query);
    if (branchId) params.set('branchId', branchId);
    const metricsParams = branchId ? `?branchId=${encodeURIComponent(branchId)}` : '';
    const [nextJobs, nextMetrics] = await Promise.all([api<Job[]>(`/jobs?${params}`), api<BoardMetrics>(`/board/metrics${metricsParams}`)]);
    setJobs(nextJobs); setMetrics(nextMetrics);
  }, [query, branchId]);
  useEffect(() => { void Promise.all([api<Service[]>('/services'), api<Branch[]>('/branches'), session.user.role === 'OWNER' ? api<AvailableEmployee[]>('/operations/available-employees') : Promise.resolve([]), api<OperationCapabilities>('/operations/capabilities')]).then(([serviceList, branchList, team, allowed]) => { setServices(serviceList); setBranches(branchList); setEmployees(team); setCapabilities(allowed); }).catch((cause) => setError(errorText(cause))); }, [session.user.role]);
  useEffect(() => { const timer = setTimeout(() => { void load().catch((cause) => setError(errorText(cause))); }, 180); return () => clearTimeout(timer); }, [load]);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 60_000); return () => clearInterval(timer); }, []);

  async function advance(job: Job, to: JobStage) {
    if (!canMoveStage(job.status as Stage, to as Stage) || to === 'HANDED_OVER') return;
    setBusyId(job.id); setError('');
    try { await post(`/jobs/${job.id}/advance`, { to }); await load(); setMobileStage(to); }
    catch (cause) { setError(errorText(cause)); await load(); }
    finally { setBusyId(null); }
  }
  function drop(event: DragEvent<HTMLElement>, stage: JobStage) {
    event.preventDefault(); setDragOver(null);
    const id = event.dataTransfer.getData('text/plain');
    const job = jobs.find((item) => item.id === id);
    if (job) void advance(job, stage);
  }
  return <div className="operations-page">
    <div className="board-bar ops-board-bar"><button className="btn primary ops-checkin-button" onClick={() => setCheckInOpen(true)}><Plus size={18} />Check-in Vehicle</button><label className="ops-search"><Search size={18} /><input aria-label="Search active vehicles" placeholder="Search vehicle or customer" value={query} onChange={(event) => setQuery(event.target.value)} /></label>{session.user.role === 'OWNER' && branches.length > 1 && <select className="input ops-branch-filter" aria-label="Branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}</div>
    {metrics && <div className="stat-strip ops-stats"><div className="stat"><span>In the bay</span><b>{metrics.inBay}</b></div><div className="stat is-ok"><span>Ready</span><b>{metrics.ready}</b></div><div className="stat is-bad"><span>Late</span><b>{metrics.late}</b></div>{session.user.role === 'OWNER' && <div className="stat is-money"><span>Collected today</span><b>{money(metrics.collectedPaise ?? 0)}</b></div>}</div>}
    <div className="seg ops-stage-tabs" role="tablist" aria-label="Board stages">{activeStages.map((stage) => <button key={stage} role="tab" aria-selected={mobileStage === stage} style={{ '--stage': stageTone[stage] } as React.CSSProperties} onClick={() => setMobileStage(stage)}><b>{jobs.filter((job) => job.status === stage).length}</b>{stageLabels[stage as Stage]}</button>)}</div>
    {error && <p className="portal-error" role="alert">{error}</p>}
    <div className="columns ops-columns">{activeStages.map((stage) => <section key={stage} className={`col${dragOver === stage ? ' drop-ok over' : ''}${mobileStage === stage ? ' is-mobile-active' : ''}`} data-drop={stage} style={{ '--stage': stageTone[stage] } as React.CSSProperties} onDragOver={(event) => { const id = event.dataTransfer.types.includes('text/plain'); if (id && stage !== 'RECEIVED') { event.preventDefault(); setDragOver(stage); } }} onDragLeave={() => setDragOver(null)} onDrop={(event) => drop(event, stage)}><header className="col-head"><span className="dot" /><b>{stageLabels[stage as Stage]}</b><span className="n">{jobs.filter((job) => job.status === stage).length}</span></header>{jobs.filter((job) => job.status === stage).map((job) => <JobCard key={job.id} job={job} late={new Date(job.expectedAt).getTime() < now} busy={busyId === job.id} canHandover={capabilities.canHandover} onOpen={() => setDetailId(job.id)} onAdvance={() => void advance(job, stage === 'RECEIVED' ? 'WASHING' : 'READY')} onHandover={() => setHandoverId(job.id)} />)}{!jobs.some((job) => job.status === stage) && <div className="empty">No vehicles here</div>}</section>)}</div>
    {checkInOpen && <CheckInSheet session={session} branches={branches} services={services} employees={employees} onClose={() => setCheckInOpen(false)} onSaved={() => { setCheckInOpen(false); setMobileStage('RECEIVED'); void load(); }} />}
    {detailId && <JobDetail jobId={detailId} role={session.user.role} onClose={() => setDetailId(null)} onChanged={() => void load()} />}
    {handoverId && <HandoverSheet jobId={handoverId} capabilities={capabilities} onClose={() => setHandoverId(null)} onSaved={() => { setHandoverId(null); void load(); }} />}
  </div>;
}

export function HistoryView({ session }: { session: Session }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [services, setServices] = useState<Service[]>([]);
  const [query, setQuery] = useState('');
  const [date, setDate] = useState('');
  const [serviceId, setServiceId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [detailId, setDetailId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    const params = new URLSearchParams({ view: 'history' });
    if (query) params.set('q', query);
    if (date) params.set('date', date);
    if (serviceId) params.set('serviceId', serviceId);
    if (branchId) params.set('branchId', branchId);
    setJobs(await api<Job[]>(`/jobs?${params}`));
  }, [query, date, serviceId, branchId]);
  useEffect(() => { void Promise.all([api<Branch[]>('/branches'), api<Service[]>('/services')]).then(([locations, offerings]) => { setBranches(locations); setServices(offerings); }).catch((cause) => setError(errorText(cause))); }, []);
  useEffect(() => { const timer = setTimeout(() => { void load().catch((cause) => setError(errorText(cause))); }, 180); return () => clearTimeout(timer); }, [load]);
  return <div className="operations-page"><div className="board-bar ops-board-bar"><label className="ops-search"><Search size={18} /><input aria-label="Search history" placeholder="Registration, customer, mobile or service" value={query} onChange={(event) => setQuery(event.target.value)} /></label><input className="input ops-date-filter" type="date" aria-label="Check-in date" value={date} onChange={(event) => setDate(event.target.value)} /><select className="input ops-branch-filter" aria-label="Service" value={serviceId} onChange={(event) => setServiceId(event.target.value)}><option value="">All services</option>{services.map((service) => <option key={service.id} value={service.id}>{service.name}</option>)}</select>{session.user.role === 'OWNER' && branches.length > 1 && <select className="input ops-branch-filter" aria-label="Branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}</div>
    {error && <p className="portal-error" role="alert">{error}</p>}
    <div className="ops-history-list">{jobs.map((job) => <button type="button" key={job.id} className="ops-history-row" onClick={() => setDetailId(job.id)}><span className="plate">{job.vehicle.registrationNumber}</span><span>{job.vehicle.make} {job.vehicle.model} · {job.customer.name}</span><span>{job.serviceName}</span><time>{job.handedOverAt ? dateTime(job.handedOverAt) : dateTime(job.checkedInAt)}</time><ArrowRight size={18} /></button>)}{jobs.length === 0 && <div className="empty">No handed-over vehicles match these filters.</div>}</div>
    {detailId && <JobDetail jobId={detailId} role={session.user.role} onClose={() => setDetailId(null)} onChanged={() => void load()} />}
  </div>;
}

export function OperationsSettingsView() {
  const [settings, setSettings] = useState<OperationSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { void api<OperationSettings>('/operations/settings').then(setSettings).catch((cause) => setError(errorText(cause))); }, []);
  async function toggle(key: keyof OperationSettings) {
    if (!settings) return;
    setBusy(true); setError('');
    try { setSettings(await patch<OperationSettings>('/operations/settings', { [key]: !settings[key] })); }
    catch (cause) { setError(errorText(cause)); }
    finally { setBusy(false); }
  }
  const fields: { key: keyof OperationSettings; label: string }[] = [
    { key: 'allowOutstanding', label: 'Allow outstanding at Handover' },
    { key: 'employeeHandover', label: 'Employees can Handover' },
    { key: 'sendHandoverMessage', label: 'Send Handover message' },
  ];
  return <div className="ops-settings"><h2>Vehicle operations</h2>{settings ? <div className="ops-settings-list">{fields.map(({ key, label }) => <label key={key} className="ops-setting-row"><span>{label}</span><input type="checkbox" checked={settings[key]} disabled={busy} onChange={() => void toggle(key)} /></label>)}</div> : <p className="ops-loading">Loading settings...</p>}{error && <p className="portal-error" role="alert">{error}</p>}</div>;
}
