import { useEffect, useState } from 'react';
import { Check, Clock3, Droplets, KeyRound, Sparkles } from 'lucide-react';
import type { JobStage, TrackingStatus } from './api';

const stages: { key: JobStage; label: string }[] = [
  { key: 'RECEIVED', label: 'Received' },
  { key: 'WASHING', label: 'Washing' },
  { key: 'READY', label: 'Ready' },
  { key: 'HANDED_OVER', label: 'Handed Over' },
];

function dateTime(value: string) {
  return `${new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }).format(new Date(value))} IST`;
}

export function TrackingView({ token }: { token: string }) {
  const [tracking, setTracking] = useState<TrackingStatus | null>(null);
  const [error, setError] = useState('');
  const [refreshError, setRefreshError] = useState(false);

  useEffect(() => {
    let active = true;
    async function refresh() {
      try {
        const response = await fetch(`/api/public/tracking/${encodeURIComponent(token)}`, { credentials: 'omit', cache: 'no-store' });
        if (!active) return;
        if (response.status === 410) { setTracking(null); setError('This tracking link has expired.'); return; }
        if (!response.ok) { setTracking(null); setError('This tracking link is unavailable.'); return; }
        setTracking(await response.json() as TrackingStatus);
        setError(''); setRefreshError(false);
      } catch {
        if (active) { setRefreshError(true); setError((previous) => previous || 'Unable to load vehicle status. Please try again.'); }
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 25_000);
    return () => { active = false; window.clearInterval(timer); };
  }, [token]);

  const currentIndex = tracking ? stages.findIndex((stage) => stage.key === tracking.status) : -1;
  const times = tracking ? [tracking.receivedAt, tracking.washingStartedAt, tracking.readyAt, tracking.handedOverAt] : [];

  return <main className="tracking-page">
    <div className="tracking-shell">
      <header className="tracking-header"><img src={tracking?.businessLogoUrl || '/kleenbay-monogram.png'} alt="" /><div><span className="tracking-brand">KleenBay</span>{tracking && <span className="tracking-business">{tracking.businessName}</span>}</div></header>
      {tracking ? <>
        <div className="tracking-intro"><span className="tracking-eyebrow">VEHICLE STATUS</span><h1>{tracking.vehicleRegistration}</h1><p>{[tracking.vehicleMake, tracking.vehicleModel].filter(Boolean).join(' ')} · {tracking.serviceName}</p></div>
        <div className={`tracking-highlight tracking-highlight-${tracking.status.toLowerCase()}`}>
          {tracking.status === 'READY' ? <Sparkles size={23} /> : tracking.status === 'HANDED_OVER' ? <KeyRound size={23} /> : tracking.status === 'WASHING' ? <Droplets size={23} /> : <Clock3 size={23} />}
          <div><strong>{tracking.status === 'READY' ? 'Your vehicle is ready for pickup.' : tracking.status === 'HANDED_OVER' ? 'Service completed' : tracking.status === 'WASHING' ? 'Your vehicle is being washed' : 'Your vehicle has been received'}</strong>
            <span>{tracking.status === 'HANDED_OVER' && tracking.handedOverAt ? `Handed over ${dateTime(tracking.handedOverAt)}` : tracking.status === 'READY' ? 'We look forward to seeing you.' : `Estimated completion ${dateTime(tracking.expectedCompletionAt)}`}</span></div>
        </div>
        <section className="tracking-progress" aria-label="Wash progress"><h2>Progress</h2><ol>{stages.map((stage, index) => <li key={stage.key} className={index < currentIndex ? 'is-done' : index === currentIndex ? 'is-current' : 'is-upcoming'} aria-current={index === currentIndex ? 'step' : undefined}><span className="tracking-step-icon">{index < currentIndex ? <Check size={17} strokeWidth={3} /> : index + 1}</span><span className="tracking-step-copy"><strong>{stage.label}</strong>{times[index] && <time>{dateTime(times[index]!)}</time>}</span></li>)}</ol></section>
        {tracking.photos.length > 0 && <section className="tracking-photos"><h2>Completed photos</h2><div>{tracking.photos.map((photo, index) => <img key={photo.url} src={photo.url} alt={`Completed vehicle view ${index + 1}`} referrerPolicy="no-referrer" loading="lazy" />)}</div></section>}
        <p className="tracking-refresh" role="status">{refreshError ? 'Connection interrupted. We will keep trying.' : 'Status updates automatically.'}</p>
      </> : <div className="tracking-empty" role={error ? 'alert' : 'status'}>{error || 'Loading vehicle status...'}</div>}
    </div>
  </main>;
}
