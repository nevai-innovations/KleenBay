import { useEffect, useState } from 'react';
import { api, post } from './api';

type Payment = { id: string; merchantTransactionId: string; providerTransactionId: string | null; amountPaise: number; status: string; initiatedAt: string; completedAt: string | null };
type Billing = {
  plan: { code: string; name: string; pricePaise: number; currency: string; billingInterval: string };
  checkoutAvailable: boolean;
  subscription: { status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; daysRemaining: number };
  payments: Payment[];
};
type Checkout = { transactionId: string; action: string; fields: Record<string, string> };

const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);
const date = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));

export function BillingView() {
  const [billing, setBilling] = useState<Billing | null>(null);
  const [mobile, setMobile] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function refresh() {
    setError('');
    try { setBilling(await api<Billing>('/billing')); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load billing'); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    void api<Billing>('/billing').then(setBilling).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not load billing')).finally(() => setLoading(false));
  }, []);

  async function checkout() {
    setBusy(true); setError('');
    try {
      const result = await post<Checkout>('/billing/checkout', { payerMobile: mobile });
      const form = document.createElement('form');
      form.method = 'POST'; form.action = result.action;
      for (const [name, value] of Object.entries(result.fields)) {
        const field = document.createElement('input');
        field.type = 'hidden'; field.name = name; field.value = value; form.append(field);
      }
      document.body.append(form);
      form.submit();
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not start checkout'); setBusy(false); }
  }

  async function reconcile(payment: Payment) {
    setBusy(true); setError('');
    try { await post(`/billing/transactions/${payment.id}/reconcile`, {}); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not check payment'); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="billing-page"><p role="status">Loading billing...</p></div>;
  if (!billing) return <div className="billing-page"><div role="alert">{error || 'Billing is unavailable'}</div><button className="btn" onClick={() => { setLoading(true); void refresh(); }}>Retry</button></div>;

  const status = billing.subscription.status;
  const statusLabel: Record<string, string> = { INACTIVE: 'Not subscribed', PAYMENT_PENDING: 'Payment pending', PAYMENT_FAILED: 'Payment unsuccessful', EXPIRED: 'Expired', ACTIVE: 'Active' };
  const pending = billing.payments.find((payment) => payment.status === 'INITIATED');
  return <div className="billing-page">
    <div className="section-head"><div><h2>Subscription</h2><p>Manage your KleenBay plan.</p></div></div>
    <section className="panel billing-panel" aria-label="KleenBay subscription">
      <div className="billing-heading"><div><h3>{billing.plan.name}</h3><strong>{money(billing.plan.pricePaise)} / year</strong></div><span className={`status-pill${status === 'ACTIVE' ? ' is-active' : ''}`}>{statusLabel[status] ?? status}</span></div>
      <p className="billing-note">WhatsApp Business API/provider charges are billed separately.</p>
      {status === 'ACTIVE' && billing.subscription.currentPeriodStart && billing.subscription.currentPeriodEnd && <div className="billing-facts"><p>Started <strong>{date(billing.subscription.currentPeriodStart)}</strong></p><p>Valid until <strong>{date(billing.subscription.currentPeriodEnd)}</strong></p><p>Days remaining <strong>{billing.subscription.daysRemaining}</strong></p></div>}
      {status === 'EXPIRED' && billing.subscription.currentPeriodEnd && <p>Expired on {date(billing.subscription.currentPeriodEnd)}.</p>}
      {billing.checkoutAvailable ? <div className="billing-checkout"><label className="field"><span>Payment contact mobile number</span><input className="input" type="tel" inputMode="tel" autoComplete="tel" value={mobile} onChange={(event) => setMobile(event.target.value)} /></label><button type="button" className="btn primary" disabled={busy || !mobile.trim()} onClick={() => void checkout()}>{status === 'ACTIVE' ? 'Renew subscription' : status === 'PAYMENT_FAILED' ? 'Try again' : `Subscribe for ${money(billing.plan.pricePaise)}/year`}</button></div> : <p className="billing-note">Online subscription checkout is not configured for this environment.</p>}
      {pending && <button type="button" className="btn" disabled={busy} onClick={() => void reconcile(pending)}>Check pending payment</button>}
      {error && <div className="portal-error" role="alert">{error}</div>}
      <nav className="billing-policies" aria-label="Billing policies"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/subscription-policy">Subscription</a><a href="/refund-policy">Refunds</a><a href="/delivery-policy">Service delivery</a></nav>
      <p className="billing-note">Policy copy is pending legal approval. Live billing must not be enabled before approval.</p>
    </section>
    <section className="panel billing-panel" aria-label="Subscription payment history"><h3>Payment History</h3>
      {billing.payments.length === 0 ? <p>No subscription payments yet.</p> : <div className="billing-history">{billing.payments.map((payment) => <div className="billing-payment" key={payment.id}><div><strong>{money(payment.amountPaise)}</strong><span>{date(payment.completedAt ?? payment.initiatedAt)} · PayU</span></div><span>{payment.status === 'SUCCESS' ? 'Success' : payment.status === 'FAILED' ? 'Failed' : payment.status === 'INITIATED' ? 'Pending' : 'Cancelled'}</span><small>Transaction: {payment.merchantTransactionId}</small></div>)}</div>}
    </section>
  </div>;
}
