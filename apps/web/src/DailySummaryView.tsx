import { useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import type { DailySummary, PaymentMethod } from '@carwash/shared';
import { api, type Branch } from './api';

const money = (paise: number) => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(paise / 100);
const methodLabels: Record<PaymentMethod, string> = { CASH: 'Cash', UPI: 'UPI', CARD: 'Card', BANK_TRANSFER: 'Bank transfer', OTHER: 'Other' };
const hourLabel = (hour: number) => `${hour % 12 || 12}${hour < 12 ? 'am' : 'pm'}`;
const turnaround = (minutes: number | null) => minutes === null ? '—' : minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;

function SummaryBars({ rows, max, highlight }: { rows: { key: string; label: string; count: number; detail: string }[]; max: number; highlight?: string }) {
  return <div className="daily-bars">{rows.map((row) => <div className={`daily-bar${row.key === highlight ? ' is-highlighted' : ''}`} key={row.key}>
    <span className="daily-bar-label">{row.label}</span><span className="daily-bar-track"><span className="daily-bar-fill" style={{ width: `${max ? row.count / max * 100 : 0}%` }} /></span><span className="daily-bar-value">{row.detail}</span>
  </div>)}</div>;
}

export function DailySummaryView() {
  const [loadedSummary, setLoadedSummary] = useState<DailySummary | null>(null);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<{ branchId: string; message: string } | null>(null);
  const [branchError, setBranchError] = useState('');
  const requestVersion = useRef(0);
  const path = `/summary/daily${branchId ? `?branchId=${encodeURIComponent(branchId)}` : ''}`;

  useEffect(() => { void api<Branch[]>('/branches').then(setBranches).catch((cause) => setBranchError(cause instanceof Error ? cause.message : 'Could not load branches')); }, []);
  useEffect(() => {
    function fetchLatest() {
      const version = ++requestVersion.current;
      void api<DailySummary>(path).then((result) => {
        if (version === requestVersion.current) { setLoadedSummary(result); setError(null); }
      }).catch((cause) => {
        if (version === requestVersion.current) setError({ branchId, message: cause instanceof Error ? cause.message : 'Could not load daily summary' });
      });
    }
    fetchLatest();
    const timer = window.setInterval(fetchLatest, 60_000);
    return () => window.clearInterval(timer);
  }, [branchId, path]);

  async function refresh() {
    setRefreshing(true);
    const version = ++requestVersion.current;
    try {
      const result = await api<DailySummary>(path);
      if (version === requestVersion.current) { setLoadedSummary(result); setError(null); }
    } catch (cause) { if (version === requestVersion.current) setError({ branchId, message: cause instanceof Error ? cause.message : 'Could not load daily summary' }); }
    finally { setRefreshing(false); }
  }

  const summary = loadedSummary?.branchId === (branchId || null) ? loadedSummary : null;
  const currentError = error?.branchId === branchId ? error.message : '';
  const serviceMax = Math.max(0, ...(summary?.services.map((item) => item.count) ?? []));
  const hourMax = Math.max(0, ...(summary?.hours.map((item) => item.count) ?? []));
  const collectionMethods = summary?.collectionByMethod.map((item) => `${methodLabels[item.method]} ${money(item.amountPaise)}`).join(' · ');

  return <div className="daily-summary-page">
    <div className="daily-toolbar">
      <span>{summary ? new Intl.DateTimeFormat('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: summary.timeZone }).format(new Date(summary.asOf)) : 'Today'}</span>
      <div className="daily-tools">{branches.length > 1 && <select className="input" aria-label="Summary branch" value={branchId} onChange={(event) => setBranchId(event.target.value)}><option value="">All branches</option>{branches.map((branch) => <option key={branch.id} value={branch.id}>{branch.name}</option>)}</select>}
        <button type="button" className="btn ghost daily-refresh" onClick={() => void refresh()} disabled={refreshing} aria-label="Refresh daily summary" title="Refresh daily summary"><RefreshCw size={18} /></button></div>
    </div>
    {(currentError || branchError) && <p className="portal-error" role="alert">{currentError || branchError}</p>}
    {!summary && !currentError ? <p className="daily-loading">Loading daily summary...</p> : summary && <>
      <div className="kpis daily-kpis">
        <div className="kpi"><span>Cars received</span><b>{summary.receivedCount}</b><small>{summary.handedOverCount} handed over today · {summary.stillOnBoardCount} from today still on board</small></div>
        <div className="kpi daily-money"><span>Collected</span><b>{money(summary.collectedPaise)}</b><small>{collectionMethods || 'No payments collected today'}</small></div>
        <div className={`kpi${summary.unpaidPaise > 0 ? ' daily-unpaid' : ''}`}><span>Unpaid</span><b>{money(summary.unpaidPaise)}</b><small>{summary.unpaidInvoiceCount} {summary.unpaidInvoiceCount === 1 ? 'invoice' : 'invoices'} today · {money(summary.pipelinePaise)} still on board</small></div>
        <div className="kpi"><span>Avg turnaround</span><b>{turnaround(summary.avgTurnaroundMinutes)}</b><small>{summary.lateCount} late or overdue</small></div>
      </div>

      <div className="daily-grid">
        <section className="panel daily-panel"><div className="panel-head"><h2>Services</h2><span className="daily-panel-meta">Check-ins · job value</span></div>
          {summary.services.length ? <SummaryBars max={serviceMax} rows={summary.services.map((item) => ({ key: item.name, label: item.name, count: item.count, detail: `${item.count} · ${money(item.valuePaise)}` }))} highlight={summary.services[0]?.name} /> : <p className="daily-empty">No vehicles checked in today.</p>}
        </section>
        <section className="panel daily-panel"><div className="panel-head"><h2>Check-ins by hour</h2>{summary.busiestHour !== null && <span className="chip">busiest {hourLabel(summary.busiestHour)}</span>}</div>
          {summary.hours.length ? <SummaryBars max={hourMax} rows={summary.hours.map((item) => ({ key: String(item.hour), label: hourLabel(item.hour), count: item.count, detail: String(item.count) }))} highlight={String(summary.busiestHour)} /> : <p className="daily-empty">No check-ins yet today.</p>}
        </section>
        <section className="panel daily-panel"><div className="panel-head"><h2>Staff activity</h2></div>
          {summary.staff.length ? <div className="daily-table-wrap"><table className="tbl"><thead><tr><th>Name</th><th>Cars</th><th>Updates</th><th>Handovers</th></tr></thead><tbody>{summary.staff.map((member) => <tr key={member.id}><td>{member.name}</td><td>{member.cars}</td><td>{member.updates}</td><td>{member.handovers}</td></tr>)}</tbody></table></div> : <p className="daily-empty">No employee stage updates today.</p>}
        </section>
        <section className="panel daily-panel"><div className="panel-head"><h2>Customers</h2></div>
          <div className="daily-customer-stats"><div><span>New</span><strong>{summary.customers.newCount}</strong></div><div><span>Returning</span><strong>{summary.customers.returningCount}</strong></div></div>
        </section>
        <section className="panel daily-panel daily-wide"><div className="panel-head"><h2>Needs attention</h2><span className={`chip ${summary.attention.length ? 'bad' : 'ok'}`}>{summary.attention.length}</span></div>
          {summary.attention.length ? <div className="daily-attention">{summary.attention.map((item, index) => <div className="daily-attention-row" key={`${item.kind}:${item.jobId}:${index}`}><strong className="plate">{item.registrationNumber}</strong><span>{item.customerName}</span><span className="daily-attention-detail">{item.detail}{item.amountPaise !== undefined ? ` · ${money(item.amountPaise)}` : ''}</span></div>)}</div> : <p className="daily-empty">Nothing needs attention right now.</p>}
        </section>
      </div>
    </>}
  </div>;
}
