import { useEffect, useState } from 'react';
import { api, post } from './api';
import { openRazorpay, type CheckoutResponse } from './razorpay-checkout';

type Payment = { id: string; provider: string; merchantTransactionId: string; providerTransactionId: string | null; razorpayPaymentId: string | null; amountPaise: number; status: string; initiatedAt: string; completedAt: string | null };
type Billing = {
  plan: { code: string; name: string; pricePaise: number; currency: string; billingInterval: string };
  checkoutAvailable: boolean;
  subscription: { status: string; currentPeriodStart: string | null; currentPeriodEnd: string | null; daysRemaining: number };
  payments: Payment[];
};
type Checkout = { transactionId: string; keyId: string; orderId: string; amountPaise: number; currency: string; name: string; prefill: { name?: string; email?: string } };

const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);
const date = (value: string) => new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium' }).format(new Date(value));

export function BillingView() {
  const [billing, setBilling] = useState<Billing | null>(null);
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
      const result = await post<Checkout>('/billing/checkout', { idempotencyKey: crypto.randomUUID() });
      let succeeded = false;
      let failed = false;
      const verify = async (response: CheckoutResponse) => {
        succeeded = true;
        try {
          const payment = await post<Payment>('/billing/razorpay/verify', response);
          await refresh();
          if (payment.status !== 'SUCCESS') setError('Payment is awaiting capture. Check pending payment shortly.');
        } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not verify payment. Check pending payment before paying again.'); }
        finally { setBusy(false); }
      };
      await openRazorpay({ key: result.keyId, order_id: result.orderId, amount: result.amountPaise, currency: result.currency, name: result.name, description: 'KleenBay Annual', prefill: result.prefill, theme: { color: '#bf8e2c' }, handler: (response) => { void verify(response); }, modal: { ondismiss: () => {
        if (succeeded) return;
        void post(`/billing/transactions/${result.transactionId}/cancel`, { outcome: failed ? 'FAILED' : 'CANCELLED' }).then(async () => { await refresh(); if (failed) setError('Payment unsuccessful. You can try again.'); }).catch((cause) => setError(cause instanceof Error ? cause.message : 'Could not check payment')).finally(() => setBusy(false));
      } } }, () => { failed = true; setError('Payment unsuccessful. You can retry in Checkout or close it.'); });
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
      {billing.checkoutAvailable ? <div className="billing-checkout"><button type="button" className="btn primary" disabled={busy} onClick={() => void checkout()}>{busy ? 'Processing...' : status === 'ACTIVE' ? 'Renew subscription' : status === 'EXPIRED' ? `Renew for ${money(billing.plan.pricePaise)}` : status === 'PAYMENT_FAILED' ? 'Try again' : `Subscribe for ${money(billing.plan.pricePaise)}`}</button></div> : <p className="billing-note">Online subscription checkout is not configured for this environment.</p>}
      {pending && <button type="button" className="btn" disabled={busy} onClick={() => void reconcile(pending)}>Check pending payment</button>}
      {error && <div className="portal-error" role="alert">{error}</div>}
      <nav className="billing-policies" aria-label="Billing policies"><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="/subscription-policy">Subscription</a><a href="/refund-policy">Refunds</a><a href="/delivery-policy">Service delivery</a></nav>
      <p className="billing-note">Policy copy is pending legal approval. Live billing must not be enabled before approval.</p>
    </section>
    <section className="panel billing-panel" aria-label="Subscription payment history"><h3>Payment History</h3>
      {billing.payments.length === 0 ? <p>No subscription payments yet.</p> : <div className="billing-history">{billing.payments.map((payment) => <div className="billing-payment" key={payment.id}><div><strong>{money(payment.amountPaise)}</strong><span>{date(payment.completedAt ?? payment.initiatedAt)} · {payment.provider === 'RAZORPAY' ? 'Razorpay' : payment.provider}</span></div><span>{payment.status === 'SUCCESS' ? 'Success' : payment.status === 'FAILED' ? 'Failed' : payment.status === 'INITIATED' ? 'Pending' : 'Cancelled'}</span><small>{payment.razorpayPaymentId ? `Payment ID: ${payment.razorpayPaymentId}` : `Transaction: ${payment.merchantTransactionId}`}</small></div>)}</div>}
    </section>
  </div>;
}
