import { requireConfig } from '@/server/config';
import { requireAdmin } from '@/server/session';
import ConfigForm from './ConfigForm';

export const dynamic = 'force-dynamic';

export default async function AdminConfigPage() {
  await requireAdmin();
  const config = await requireConfig();

  return (
    <>
      <p className="eyebrow">Admin</p>
      <h1>Configuration</h1>
      <p className="subtitle">
        Connected to {config.serverType}. The server type is fixed for this deployment.
      </p>
      <ConfigForm
        serverUrl={config.serverUrl}
        hasTmdbKey={Boolean(config.tmdbApiKey)}
        features={config.features}
      />
    </>
  );
}
