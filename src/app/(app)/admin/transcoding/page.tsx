import { BarChart, DonutChart, StatCard } from '@/components/Charts';
import { formatDuration, percent } from '@/components/format';
import {
  getAudioCodecs,
  getBitrateBuckets,
  getContainers,
  getPlaybackTotals,
  getPlayMethods,
  getResolutions,
  getTranscodeReasons,
  getVideoCodecs,
} from '@/server/playback';
import { requireAdmin } from '@/server/session';

export const dynamic = 'force-dynamic';

export default async function AdminTranscodingPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin();
  const raw = (await searchParams).days;
  const days = raw === 'all' ? undefined : Number(raw ?? 30);

  const [totals, methods, reasons, video, audio, containers, resolutions, bitrates] =
    await Promise.all([
      getPlaybackTotals(days),
      getPlayMethods(days),
      getTranscodeReasons(days),
      getVideoCodecs(days),
      getAudioCodecs(days),
      getContainers(days),
      getResolutions(days),
      getBitrateBuckets(days),
    ]);

  const directPlay = totals.sessions - totals.transcodes;

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Transcoding Statistics</h1>
      <p className="subtitle">
        How the server delivered content. Recorded from live sessions, so numbers start at
        zero on a fresh install and grow as people watch.
      </p>

      <form className="filters">
        <label>
          Period
          <select name="days" defaultValue={raw ?? '30'}>
            <option value="7">Last 7 days</option>
            <option value="30">Last 30 days</option>
            <option value="90">Last 90 days</option>
            <option value="all">All time</option>
          </select>
        </label>
        <button>Apply</button>
      </form>

      <div className="grid cols-4">
        <StatCard
          label="Sessions"
          value={String(totals.sessions)}
          info="Playback sessions observed by the activity poller."
        />
        <StatCard
          label="Direct play"
          value={`${percent(directPlay, totals.sessions)}%`}
          hint={`${directPlay} of ${totals.sessions}`}
          info="Share of sessions the server delivered without re-encoding."
        />
        <StatCard
          label="Average bitrate"
          value={`${(totals.avgBitrateKbps / 1000).toFixed(1)} Mbps`}
          hint={`min ${(totals.minBitrateKbps / 1000).toFixed(1)} · max ${(totals.maxBitrateKbps / 1000).toFixed(1)}`}
        />
        <StatCard label="Streamed" value={formatDuration(totals.watchtimeMs)} />
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Playback method</h2>
          <div className="card">
            <DonutChart data={methods} format={(v) => `${v} sessions`} />
          </div>
        </section>
        <section>
          <h2>Why content was transcoded</h2>
          <div className="card">
            <BarChart data={reasons} format={(v) => `${v} sessions`} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Video codecs</h2>
          <div className="card">
            <BarChart data={video} format={(v) => `${v} sessions`} />
          </div>
        </section>
        <section>
          <h2>Audio codecs</h2>
          <div className="card">
            <BarChart data={audio} format={(v) => `${v} sessions`} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>Containers</h2>
          <div className="card">
            <BarChart data={containers} format={(v) => `${v} sessions`} />
          </div>
        </section>
        <section>
          <h2>Resolutions</h2>
          <div className="card">
            <BarChart data={resolutions} format={(v) => `${v} sessions`} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>Bitrate distribution</h2>
        <div className="card">
          <BarChart data={bitrates} format={(v) => `${v} sessions`} />
        </div>
      </section>
    </>
  );
}
