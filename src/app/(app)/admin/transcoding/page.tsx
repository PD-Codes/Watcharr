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
import { getT } from '@/i18n/server';

export const dynamic = 'force-dynamic';

export default async function AdminTranscodingPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  await requireAdmin();
  const t = await getT();
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
      <p className="eyebrow">{t('nav.admin')}</p>
      <h1>{t('transcoding.title')}</h1>
      <p className="subtitle">{t('transcoding.subtitle')}</p>

      <form className="filters">
        <label>
          {t('serverstats.period')}
          <select name="days" defaultValue={raw ?? '30'}>
            <option value="7">{t('serverstats.last7')}</option>
            <option value="30">{t('serverstats.last30')}</option>
            <option value="90">{t('serverstats.last90')}</option>
            <option value="all">{t('common.allTime')}</option>
          </select>
        </label>
        <button>{t('action.apply')}</button>
      </form>

      <div className="grid cols-4">
        <StatCard
          label={t('transcoding.sessions')}
          value={String(totals.sessions)}
          info={t('transcoding.sessionsInfo')}
        />
        <StatCard
          label={t('stream.directPlay')}
          value={`${percent(directPlay, totals.sessions)}%`}
          hint={t('transcoding.directPlayHint', { direct: directPlay, total: totals.sessions })}
          info={t('transcoding.directPlayInfo')}
        />
        <StatCard
          label={t('transcoding.averageBitrate')}
          value={`${(totals.avgBitrateKbps / 1000).toFixed(1)} Mbps`}
          hint={t('transcoding.bitrateHint', {
            min: (totals.minBitrateKbps / 1000).toFixed(1),
            max: (totals.maxBitrateKbps / 1000).toFixed(1),
          })}
        />
        <StatCard label={t('transcoding.streamed')} value={formatDuration(totals.watchtimeMs)} />
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('stats.playbackMethod')}</h2>
          <div className="card">
            <DonutChart data={methods} format={(v) => t('common.sessions', { count: v })} />
          </div>
        </section>
        <section>
          <h2>{t('stats.transcodeReasons')}</h2>
          <div className="card">
            <BarChart data={reasons} format={(v) => t('common.sessions', { count: v })} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('stats.videoCodecs')}</h2>
          <div className="card">
            <BarChart data={video} format={(v) => t('common.sessions', { count: v })} />
          </div>
        </section>
        <section>
          <h2>{t('transcoding.audioCodecs')}</h2>
          <div className="card">
            <BarChart data={audio} format={(v) => t('common.sessions', { count: v })} />
          </div>
        </section>
      </div>

      <div className="grid cols-2 section">
        <section>
          <h2>{t('transcoding.containers')}</h2>
          <div className="card">
            <BarChart data={containers} format={(v) => t('common.sessions', { count: v })} />
          </div>
        </section>
        <section>
          <h2>{t('stats.resolutions')}</h2>
          <div className="card">
            <BarChart data={resolutions} format={(v) => t('common.sessions', { count: v })} />
          </div>
        </section>
      </div>

      <section className="section">
        <h2>{t('stats.bitrate')}</h2>
        <div className="card">
          <BarChart data={bitrates} format={(v) => t('common.sessions', { count: v })} />
        </div>
      </section>
    </>
  );
}
