'use client';

import { useEffect, useState } from 'react';

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
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<Details | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || details || error || !ip) return;
    let cancelled = false;
    void (async () => {
      const res = await fetch(`/api/ip?ip=${encodeURIComponent(ip)}`).catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        const body = (await res?.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? 'Could not resolve this address');
        return;
      }
      setDetails((await res.json()) as Details);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, details, error, ip]);

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
            aria-label={`Address ${ip}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="modal-head">
              <h2 style={{ margin: 0 }}>{ip}</h2>
              <button type="button" className="outlined" onClick={() => setOpen(false)}>
                Close
              </button>
            </div>

            {error && <p className="error">{error}</p>}
            {!details && !error && <p className="muted">Resolving…</p>}

            {details && (
              <>
                <p className="stat-label" style={{ marginTop: 4 }}>
                  Connection
                </p>
                <Row label="Location" value={details.isLocal ? 'LAN' : 'WAN'} />
                <Row label="Host" value={details.host} />

                {!details.isLocal && (
                  <>
                    <p className="stat-label" style={{ marginTop: 16 }}>
                      Geolocation
                    </p>
                    {located ? (
                      <>
                        <Row label="Location" value={located} />
                        <Row label="Continent" value={details.continent} />
                        <Row label="Postal code" value={details.postalCode} />
                        <Row label="Timezone" value={details.timezone} />
                        <Row
                          label="Coordinates"
                          value={
                            details.latitude && details.longitude
                              ? `${details.latitude}, ${details.longitude}`
                              : null
                          }
                        />
                      </>
                    ) : (
                      <p className="muted">
                        No geolocation data. Country lookup is off, or the provider returned
                        nothing — see Settings.
                      </p>
                    )}

                    {(details.isp || details.organisation || details.asn) && (
                      <>
                        <p className="stat-label" style={{ marginTop: 16 }}>
                          Network
                        </p>
                        <Row label="ISP" value={details.isp} />
                        <Row label="Organisation" value={details.organisation} />
                        <Row label="ASN" value={details.asn} />
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
