'use client';

import { useEffect, useState } from 'react';
import { useT } from '@/i18n/client';

// The address itself is the control: clicking it resolves the address on demand rather
// than on render, so a history page with fifty rows costs nothing until someone asks.

interface Details {
  ip: string;
  isLocal: boolean;
  country: string | null;
  continent: string | null;
  region: string | null;
  city: string | null;
  postalCode: string | null;
  latitude: string | null;
  longitude: string | null;
  timezone: string | null;
  isp: string | null;
  organisation: string | null;
  asn: string | null;
  host: string | null;
}

function Row({ label, value }: { label: string; value: string | null }) {
  if (!value) return null;
  return (
    <p style={{ margin: '2px 0' }}>
      <span className="muted">{label}: </span>
      {value}
    </p>
  );
}

export default function IpLink({ ip }: { ip: string | null }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Bumped by the refresh button, which is also what re-runs the effect below.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open || details || error || !ip) return;
    let cancelled = false;
    void (async () => {
      const query = `ip=${encodeURIComponent(ip)}${attempt > 0 ? '&refresh=1' : ''}`;
      const res = await fetch(`/api/ip?${query}`).catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        const body = (await res?.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? t('ip.resolveFailed'));
        return;
      }
      setDetails((await res.json()) as Details);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, details, error, ip, t, attempt]);

  // Clearing the result is what triggers the fetch again — the effect bails while one is
  // already there. A cached row from before the country lookup was switched on lives for a
  // month, so without this the dialog would keep repeating the same empty answer.
  function refresh() {
    setDetails(null);
    setError(null);
    setAttempt((n) => n + 1);
  }

  // Escape closes the dialog, the same as the command palette.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!ip) return <span className="muted">—</span>;

  const located =
    details && [details.city, details.region, details.country].filter(Boolean).join(', ');

  return (
    <>
      <button type="button" className="ip-link" onClick={() => setOpen(true)}>
        {ip}
      </button>

      {open && (
        <div className="modal-backdrop" onClick={() => setOpen(false)} role="presentation">
          <div
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-label={t('ip.dialog', { ip })}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 style={{ margin: 0 }}>{ip}</h2>
              <div className="row" style={{ gap: 8 }}>
                <button type="button" className="outlined" onClick={refresh}>
                  {t('ip.refresh')}
                </button>
                <button type="button" className="outlined" onClick={() => setOpen(false)}>
                  {t('ip.close')}
                </button>
              </div>
            </div>

            {error && <p className="error">{error}</p>}
            {!details && !error && <p className="muted">{t('ip.resolving')}</p>}

            {details && (
              <>
                <p className="stat-label" style={{ marginTop: 4 }}>
                  {t('ip.connection')}
                </p>
                <Row label={t('ip.location')} value={details.isLocal ? t('stream.lan') : t('stream.wan')} />
                <Row label={t('ip.host')} value={details.host} />

                {!details.isLocal && (
                  <>
                    <p className="stat-label" style={{ marginTop: 16 }}>
                      {t('ip.geolocation')}
                    </p>
                    {located ? (
                      <>
                        <Row label={t('ip.location')} value={located} />
                        <Row label={t('ip.continent')} value={details.continent} />
                        <Row label={t('ip.postalCode')} value={details.postalCode} />
                        <Row label={t('ip.timezone')} value={details.timezone} />
                        <Row
                          label={t('ip.coordinates')}
                          value={
                            details.latitude && details.longitude
                              ? `${details.latitude}, ${details.longitude}`
                              : null
                          }
                        />
                      </>
                    ) : (
                      <p className="muted">
                        {t('ip.noGeo')}
                      </p>
                    )}

                    {(details.isp || details.organisation || details.asn) && (
                      <>
                        <p className="stat-label" style={{ marginTop: 16 }}>
                          {t('ip.network')}
                        </p>
                        <Row label={t('ip.isp')} value={details.isp} />
                        <Row label={t('ip.organisation')} value={details.organisation} />
                        <Row label={t('ip.asn')} value={details.asn} />
                      </>
                    )}
                  </>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
