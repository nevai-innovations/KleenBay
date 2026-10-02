import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CarFront, ChartNoAxesColumn, Columns3, ContactRound, CreditCard, History, Pencil, Settings2, Sparkles, Users } from 'lucide-react';
import { api, patch, post, type Branch, type Employee, type Session } from './api';
import { CustomersView, ServicesView, VehiclesView } from './CatalogViews';
import { BoardView, HistoryView, OperationsSettingsView } from './OperationsViews';
import { DailySummaryView } from './DailySummaryView';
import { OwnerSetupView } from './OwnerSetupView';
import { WhatsAppSettingsView } from './WhatsAppSettingsView';
import { TrackingView } from './TrackingView';
import { BillingView } from './BillingView';
import { isLegalPath, LegalView } from './LegalView';
import { captchaId, initializeWidget, sendWidgetOtp, verifyWidgetOtp, type Msg91WidgetConfig } from './msg91-otp';

type OtpConfig = { provider: 'development' | 'dummy' | 'msg91' | 'unconfigured'; otpLength: number; widgetId?: string; widgetToken?: string };
type OtpRequest = { resendAfterSeconds: number; expiresInSeconds: number; otpLength: number };
type PendingChallenge = { mobile: string; config: OtpConfig; expiresAt: number; resendAt: number };

function Field({ label, ...props }: { label: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return <label className="field"><span>{label}</span><input className="input" {...props} /></label>;
}

function BrandLogo({ mobile = false }: { mobile?: boolean }) {
  return <span className={`brand-art${mobile ? ' mobile-brand-art' : ''}`}><img src="/kleenbay-monogram.png" alt="" /></span>;
}

function Brand({ subtitle }: { subtitle?: string }) {
  return <div className="login-brand"><BrandLogo /><span className="brand-copy"><strong>KleenBay</strong>{subtitle && <small>{subtitle}</small>}</span></div>;
}

function OtpBoxes({ code, onChange, length }: { code: string; onChange: (code: string) => void; length: number }) {
  return <div className="otp-digits">
    <input aria-label="Verification code" type="text" inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" maxLength={length} value={code} onChange={(event) => onChange(event.target.value.replace(/\D/g, '').slice(0, length))} autoFocus />
    {Array.from({ length }, (_, index) => <span key={index} className={`otp-slot${index === Math.min(code.length, length - 1) ? ' is-current' : ''}`} aria-hidden="true">{code[index] || ''}</span>)}
  </div>;
}

function Login({ onLogin }: { onLogin: (session: Session) => void }) {
  const [mode, setMode] = useState<'owner' | 'employee'>('owner');
  const [ownerLogin, setOwnerLogin] = useState('');
  const [password, setPassword] = useState('');
  const [mobile, setMobile] = useState('');
  const [code, setCode] = useState('');
  const [otpConfig, setOtpConfig] = useState<OtpConfig | null>(null);
  const [requestId, setRequestId] = useState<string | undefined>();
  const [pendingChallenge, setPendingChallenge] = useState<PendingChallenge | null>(null);
  const [otpSent, setOtpSent] = useState(false);
  const [resendAt, setResendAt] = useState(0);
  const [now, setNow] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const remaining = Math.max(0, Math.ceil((resendAt - now) / 1000));
  const mobileDigits = mobile.replace(/\D/g, '').slice(-10);

  useEffect(() => {
    if (!otpSent) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [otpSent]);

  async function act(work: () => Promise<void>) {
    setBusy(true); setError('');
    try { await work(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Request failed'); }
    finally { setBusy(false); }
  }

  function ownerSubmit(event: FormEvent) {
    event.preventDefault();
    void act(async () => onLogin(await post<Session>('/auth/owner/login', { login: ownerLogin, password })));
  }
  async function sendEmployeeOtp(config: OtpConfig) {
    const normalizedMobile = `+91${mobileDigits}`;
    if (config.provider === 'msg91') await initializeWidget(config as Msg91WidgetConfig);
    let challenge = pendingChallenge?.mobile === normalizedMobile && pendingChallenge.expiresAt > Date.now() ? pendingChallenge : null;
    if (!challenge) {
      const requested = await post<OtpRequest>('/auth/employee/request-otp', { mobile });
      const now = Date.now();
      challenge = { mobile: normalizedMobile, config, expiresAt: now + requested.expiresInSeconds * 1000, resendAt: now + requested.resendAfterSeconds * 1000 };
      setPendingChallenge(challenge);
    }
    const nextRequestId = config.provider === 'msg91' ? await sendWidgetOtp(config as Msg91WidgetConfig, normalizedMobile) : undefined;
    setPendingChallenge(null);
    setRequestId(nextRequestId);
    setCode(''); setResendAt(challenge.resendAt); setNow(Date.now()); setOtpSent(true);
  }
  function employeeSubmit(event: FormEvent) {
    event.preventDefault();
    void act(async () => {
      if (!otpSent) {
        const config = pendingChallenge?.config ?? await api<OtpConfig>('/auth/employee/otp-config');
        if (config.provider === 'unconfigured') throw new Error('Employee OTP is not configured');
        await sendEmployeeOtp(config);
        setOtpConfig(config);
      } else {
        const payload = otpConfig?.provider === 'msg91'
          ? { mobile, accessToken: await verifyWidgetOtp(otpConfig as Msg91WidgetConfig, code, requestId) }
          : { mobile, code };
        onLogin(await post<Session>('/auth/employee/verify-otp', payload));
      }
    });
  }

  function editMobile() { setOtpSent(false); setPendingChallenge(null); setCode(''); setError(''); }

  function resendCode() {
    void act(async () => {
      if (!otpConfig) throw new Error('OTP service is not configured');
      await sendEmployeeOtp(otpConfig);
    });
  }

  return <div className={`login-page${otpSent && mode === 'employee' ? ' is-verifying' : ''}`}>
    <div className="login-wrap">
      <Brand  />
      <div className={`login-box${otpSent && mode === 'employee' ? ' is-verifying' : ''}`}>
        {otpSent && mode === 'employee' ? <div className="otp-view">
          <button type="button" className="otp-back" onClick={editMobile} aria-label="Back to mobile number" title="Back to mobile number"><ArrowLeft size={20} /></button>
          <div className="otp-intro"><h1>{otpConfig?.provider === 'msg91' ? 'We just sent an SMS' : 'Enter test code'}</h1><p>{otpConfig?.provider === 'msg91' ? 'Enter the security code we sent to' : 'No SMS is sent in this test environment'}</p><div className="otp-phone"><span>+91 {mobileDigits}</span><button type="button" onClick={editMobile} aria-label="Edit mobile number" title="Edit mobile number"><Pencil size={16} /></button></div></div>
          <form onSubmit={employeeSubmit} className="otp-form"><OtpBoxes code={code} onChange={setCode} length={otpConfig?.otpLength ?? 6} /><button className="btn primary block" disabled={busy || code.length !== (otpConfig?.otpLength ?? 6)}>Verify</button></form>
          <div className="otp-resend"><span>Didn't receive the code?</span>{remaining > 0 ? <span>Resend in {String(Math.floor(remaining / 60)).padStart(2, '0')}:{String(remaining % 60).padStart(2, '0')}</span> : <button type="button" disabled={busy} onClick={resendCode}>Resend code</button>}</div>
          {error && <div className="login-error" role="alert">{error}</div>}
        </div> : <><div className="login-choices" role="tablist" aria-label="Login type">
          <button type="button" role="tab" id="owner-tab" aria-controls="login-panel" aria-selected={mode === 'owner'} onClick={() => { setMode('owner'); setError(''); }}>Owner Login</button>
          <button type="button" role="tab" id="employee-tab" aria-controls="login-panel" aria-selected={mode === 'employee'} onClick={() => { setMode('employee'); setError(''); }}>Employee Login</button>
        </div>
        <div className="login-panel" id="login-panel" role="tabpanel" aria-labelledby={mode === 'owner' ? 'owner-tab' : 'employee-tab'}>
          {mode === 'owner' ? <form onSubmit={ownerSubmit}>
            <p className="login-subtitle">Manage your car wash business</p>
            <Field label="Username / Email" autoComplete="username" value={ownerLogin} onChange={(event) => setOwnerLogin(event.target.value)} required />
            <Field label="Password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            <button className="btn primary block" disabled={busy}>Sign in as owner</button>
          </form> : <form onSubmit={employeeSubmit}>
            <p className="login-subtitle">View jobs and update wash progress</p>
            <Field label="Mobile number" type="tel" autoComplete="tel" inputMode="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} required />
            <button className="btn primary block" disabled={busy}>Send OTP</button>
          </form>}
          {error && <div className="login-error" role="alert">{error}</div>}
        </div>
        </>}
      </div>
      <div id={captchaId} />
    </div>
  </div>;
}

type OwnerSection = 'board' | 'summary' | 'history' | 'employees' | 'customers' | 'vehicles' | 'services' | 'billing' | 'settings';
function OwnerPortal({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [section, setSection] = useState<OwnerSection>(() => window.location.pathname === '/billing' ? 'billing' : 'board');
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [name, setName] = useState('');
  const [mobile, setMobile] = useState('');
  const [branchId, setBranchId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function refresh() {
    const [staff, locations] = await Promise.all([api<Employee[]>('/employees'), api<Branch[]>('/branches')]);
    setEmployees(staff); setBranches(locations);
  }
  useEffect(() => {
    void Promise.all([api<Employee[]>('/employees'), api<Branch[]>('/branches')])
      .then(([staff, locations]) => { setEmployees(staff); setBranches(locations); })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'Failed to load employees'));
  }, []);

  async function addEmployee(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      await post('/employees', { name, mobile, ...(branchId ? { branchId } : {}) });
      setName(''); setMobile(''); setBranchId(''); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not add employee'); }
    finally { setBusy(false); }
  }

  async function toggle(employee: Employee) {
    setError('');
    try { await patch(`/employees/${employee.id}`, { active: !employee.active }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not update employee'); }
  }

  useEffect(() => {
    const onPopState = () => setSection(window.location.pathname === '/billing' ? 'billing' : 'board');
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);
  function navigate(next: OwnerSection) {
    setSection(next);
    window.history.pushState(null, '', next === 'billing' ? '/billing' : '/');
  }

  const navigation = [
    { id: 'board' as const, label: 'Board', icon: Columns3 },
    { id: 'summary' as const, label: 'Daily Summary', icon: ChartNoAxesColumn },
    { id: 'history' as const, label: 'History', icon: History },
    { id: 'employees' as const, label: 'Employees', icon: Users },
    { id: 'customers' as const, label: 'Customers', icon: ContactRound },
    { id: 'vehicles' as const, label: 'Vehicles', icon: CarFront },
    { id: 'services' as const, label: 'Services', icon: Sparkles },
    { id: 'billing' as const, label: 'Billing', icon: CreditCard },
    { id: 'settings' as const, label: 'Settings', icon: Settings2 },
  ];
  const sectionTitle = navigation.find((item) => item.id === section)!.label;
  let content: ReactNode;
  switch (section) {
    case 'board': content = <BoardView session={session} />; break;
    case 'summary': content = <DailySummaryView />; break;
    case 'history': content = <HistoryView session={session} />; break;
    case 'customers': content = <CustomersView />; break;
    case 'vehicles': content = <VehiclesView />; break;
    case 'services': content = <ServicesView />; break;
    case 'billing': content = <BillingView />; break;
    case 'settings': content = <OwnerSettings />; break;
    case 'employees': content = <>
      <div className="section-head"><div><h2>Team</h2><p>Manage who can sign in and work on vehicles.</p></div><span className="count-chip">{employees.filter((employee) => employee.active).length} active</span></div>
      <div className="team-layout"><section className="panel team-list" aria-label="Employees"><div className="team-list-head"><strong>Employees</strong><span>{employees.length}</span></div>
        {employees.length === 0 ? <div className="team-empty">No employees yet.</div> : employees.map((employee) => <div className="team-row" key={employee.id}><span className="who-dot">{employee.name.slice(0, 1)}</span><div className="team-person"><strong>{employee.name}</strong><small>{employee.mobile}{employee.branchName ? ` · ${employee.branchName}` : ''}</small></div><span className={`status-pill ${employee.active ? 'is-active' : ''}`}>{employee.active ? 'Active' : 'Inactive'}</span><button className="btn small" onClick={() => void toggle(employee)}>{employee.active ? 'Deactivate' : 'Activate'}</button></div>)}</section>
        <form className="panel add-form" onSubmit={addEmployee}><h3>Add Employee</h3><Field label="Employee name" value={name} onChange={(event) => setName(event.target.value)} required /><Field label="Mobile number" type="tel" inputMode="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} required />
          {branches.length > 1 && <label className="field"><span>Branch</span><select className="input" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.map((branch) => <option value={branch.id} key={branch.id}>{branch.name}</option>)}</select></label>}
          <button className="btn primary block" disabled={busy}>Add employee</button></form></div>
      {error && <div className="portal-error" role="alert">{error}</div>}
    </>; break;
  }

  return <div className="shell">
    <aside className="rail"><Brand />
      <nav className="rail-nav" aria-label="Owner navigation">{navigation.map(({ id, label, icon: Icon }) => <button type="button" key={id} className={section === id ? 'active' : ''} onClick={() => navigate(id)}><Icon size={18} /><span>{label}</span></button>)}</nav>
      <div className="rail-foot"><span className="who-dot">{session.user.name.slice(0, 1)}</span><button className="text-action" onClick={onLogout}>Sign out</button></div>
    </aside>
    <div className="frame"><header className="topbar"><div className="topbar-identity"><BrandLogo mobile /><div className="topbar-title"><h1>{sectionTitle}</h1>{section === 'summary' && <p>Today</p>}</div></div><button className="btn ghost logout-mobile" onClick={onLogout}>Sign out</button></header>
      <nav className="portal-tabs owner-tabs" aria-label="Owner sections">{navigation.map(({ id, label }) => <button type="button" key={id} className={section === id ? 'active' : ''} onClick={() => navigate(id)}>{label}</button>)}</nav>
      <main className="portal-main">{content}</main></div>
  </div>;
}

function OwnerSettings() {
  const [tab, setTab] = useState<'operations' | 'whatsapp'>('operations');
  return <><nav className="settings-tabs" aria-label="Settings sections"><button type="button" className={tab === 'operations' ? 'active' : ''} onClick={() => setTab('operations')}>Operations</button><button type="button" className={tab === 'whatsapp' ? 'active' : ''} onClick={() => setTab('whatsapp')}>WhatsApp</button></nav>{tab === 'operations' ? <OperationsSettingsView /> : <WhatsAppSettingsView />}</>;
}

function EmployeePortal({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [section, setSection] = useState<'board' | 'history'>('board');
  return <div className="shell">
    <aside className="rail"><Brand /><nav className="rail-nav" aria-label="Employee navigation"><button className={section === 'board' ? 'active' : ''} onClick={() => setSection('board')}><Columns3 size={18} /><span>Board</span></button><button className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}><History size={18} /><span>History</span></button></nav><div className="rail-foot"><span className="who-dot">{session.user.name.slice(0, 1)}</span><button className="text-action" onClick={onLogout}>Sign out</button></div></aside>
    <div className="frame"><header className="topbar"><div className="topbar-identity"><BrandLogo mobile /><div className="topbar-title"><h1>{section === 'board' ? 'Board' : 'History'}</h1></div></div><button className="btn ghost logout-mobile" onClick={onLogout}>Sign out</button></header><nav className="portal-tabs" aria-label="Employee sections"><button className={section === 'board' ? 'active' : ''} onClick={() => setSection('board')}>Board</button><button className={section === 'history' ? 'active' : ''} onClick={() => setSection('history')}>History</button></nav><main className="portal-main">{section === 'board' ? <BoardView session={session} /> : <HistoryView session={session} />}</main></div>
  </div>;
}

export default function App() {
  const trackToken = /^\/track\/(.+)$/.exec(window.location.pathname)?.[1];
  const [setupToken, setSetupToken] = useState(() => {
    return /^#owner-setup=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? null;
  });
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [logoutError, setLogoutError] = useState('');
  useEffect(() => { if (trackToken || isLegalPath(window.location.pathname)) return; void api<Session>('/auth/me').then(setSession).catch(() => {}).finally(() => setLoading(false)); }, [trackToken]);
  useEffect(() => { document.body.classList.toggle('authed', !!session); }, [session]);
  async function logout() {
    setLogoutError('');
    try { await post('/auth/logout', {}); setSession(null); }
    catch (cause) { setLogoutError(cause instanceof Error ? cause.message : 'Could not sign out'); }
  }
  if (trackToken) return <TrackingView token={trackToken} />;
  if (isLegalPath(window.location.pathname)) return <LegalView path={window.location.pathname} />;
  if (loading) return <div className="loading-screen">KleenBay</div>;
  if (setupToken) return <OwnerSetupView token={setupToken} onComplete={() => { window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`); setSetupToken(null); }} />;
  if (!session) return <Login onLogin={setSession} />;
  if (window.location.pathname === '/billing' && session.user.role !== 'OWNER') return <main className="login-page"><div className="login-box"><h1>Access denied</h1><p>Billing is available to owners only.</p><button className="btn" onClick={() => { window.history.replaceState(null, '', '/'); window.location.reload(); }}>Back to board</button></div></main>;
  return <>{session.user.role === 'OWNER' ? <OwnerPortal session={session} onLogout={() => void logout()} /> : <EmployeePortal session={session} onLogout={() => void logout()} />}{logoutError && <div className="global-error" role="alert">{logoutError}</div>}</>;
}
