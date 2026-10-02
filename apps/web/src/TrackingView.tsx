import { useEffect, useState } from 'react';
import { stageLabels } from '@carwash/shared';
import { api, type TrackingStatus } from './api';

export function TrackingView({ token }: { token: string }) {
  const [status, setStatus] = useState<TrackingStatus | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<TrackingStatus>(`/public/track/${encodeURIComponent(token)}`).then(setStatus).catch(() => setError('This tracking link is unavailable.'));
  }, [token]);
  return <main className="tracking-page"><div className="tracking-content"><h1>KleenBay</h1>{error ? <p role="alert">{error}</p> : status ? <><p>{status.businessName}</p><h2>{status.vehicleNumber}</h2><p>{status.serviceName}</p><strong className="tracking-stage">{stageLabels[status.status]}</strong><p>{status.status === 'HANDED_OVER' ? 'Vehicle handed over' : `Estimated completion: ${new Date(status.expectedAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}`}</p></> : <p>Loading vehicle status...</p>}</div></main>;
}
