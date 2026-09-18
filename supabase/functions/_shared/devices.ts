import type { SupabaseRest } from './rest.ts';

/** Registration preserves the device owner atomically, including concurrent retries. */
export function createDeviceRegistrar(rest: SupabaseRest) {
  return async (row: Record<string, unknown>) => {
    if (!rest.configured) return [];
    return await rest.rpc('register_noop_device', {
      p_device: row.id,
      p_user: row.user_id,
      p_external_device_id: row.external_device_id,
      p_last_seen_at: row.last_seen_at,
    });
  };
}
