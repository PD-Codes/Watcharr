// Feature toggles are stored in app_config.features and default to on when unset.
export const FEATURE_FLAGS = [
  { key: 'suggestions', label: 'Suggestions' },
  { key: 'watchlistSync', label: 'Sync the Plex watchlist' },
  { key: 'serverWideStats', label: 'Server-wide statistics for admins' },
] as const;

export type FeatureKey = (typeof FEATURE_FLAGS)[number]['key'];

export function isEnabled(features: Record<string, boolean> | null, key: string): boolean {
  return features?.[key] !== false;
}
