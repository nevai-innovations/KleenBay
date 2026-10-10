import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from './api';
import './entitlement.css';

export type Access = { canCreateWork: boolean; canOperate: boolean; state?: 'NOT_SUBSCRIBED' | 'ACTIVE' | 'GRACE_PERIOD' | 'EXPIRED'; currentPeriodEnd?: string | null; daysRemaining?: number; graceDaysRemaining?: number };
const AccessContext = createContext<Access>({ canCreateWork: true, canOperate: true });
export const useOperationalAccess = () => useContext(AccessContext);

export function ownerWarning(access: Access) {
  if (access.state === 'NOT_SUBSCRIBED') return 'Subscribe to activate KleenBay operations.';
  if (access.state === 'EXPIRED') return 'Subscription expired. Renew to continue operations.';
  if (access.state === 'GRACE_PERIOD') return `Subscription expired. ${access.graceDaysRemaining} days of grace remaining. New check-ins are disabled.`;
  if (access.state === 'ACTIVE' && access.daysRemaining !== undefined && access.daysRemaining <= 30) {
    return access.daysRemaining === 1 ? 'Your subscription expires tomorrow.' : `Your KleenBay subscription expires in ${access.daysRemaining} days.${access.daysRemaining <= 7 ? ' Renew now.' : ''}`;
  }
  return null;
}

export function EntitlementBoundary({ role, children, onLogout }: { role: 'OWNER' | 'EMPLOYEE'; children: ReactNode; onLogout: () => void }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let mounted = true;
    const refresh = () => { void api<Access>('/entitlement').then((value) => { if (mounted) { setAccess(value); setError(''); } }).catch(() => { if (mounted) { setAccess(null); setError('Could not check business access. Please try again.'); } }); };
    refresh();
    const timer = window.setInterval(refresh, 20_000);
    window.addEventListener('kleenbay:subscription-updated', refresh);
    window.addEventListener('focus', refresh);
    return () => { mounted = false; window.clearInterval(timer); window.removeEventListener('kleenbay:subscription-updated', refresh); window.removeEventListener('focus', refresh); };
  }, []);
  if (!access) return <main className="login-page"><div className="login-box"><p role="status">{error || 'Checking business access...'}</p>{error && <button className="btn" onClick={() => window.location.reload()}>Retry</button>}<button className="btn" onClick={onLogout}>Sign out</button></div></main>;
  if (role === 'EMPLOYEE' && !access.canOperate) return <main className="login-page"><div className="login-box"><h1>Operations unavailable</h1><p>Your business subscription is inactive. Please contact the owner.</p><button className="btn" onClick={onLogout}>Sign out</button></div></main>;
  const warning = role === 'OWNER' ? ownerWarning(access) : null;
  return <AccessContext.Provider value={access}>{warning && <aside className="subscription-warning" role="status"><span>{warning}</span><a href="/billing">{access.state === 'NOT_SUBSCRIBED' ? 'Subscribe' : 'Renew now'}</a></aside>}{children}</AccessContext.Provider>;
}
