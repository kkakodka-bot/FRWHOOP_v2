/** Apply replace-window absence deletes for NOOP push projections. */

export async function deleteReplacementRows(rest, table, filter) {
  if (!rest?.configured) return;

  if (table === 'daily_metrics') {
    const rows = await rest.select(
      'daily_metrics',
      `user_id=eq.${filter.userId}&day=gte.${filter.dayGte}&day=lt.${filter.dayLt}&select=day`,
    );
    for (const row of rows) {
      if (!filter.keepKeys.has(String(row.day))) {
        await rest.delete('daily_metrics', `user_id=eq.${filter.userId}&day=eq.${row.day}`);
      }
    }
    return;
  }

  if (table === 'noop_journal_entries') {
    const rows = await rest.select(
      'noop_journal_entries',
      `user_id=eq.${filter.userId}&device_id=eq.${filter.deviceId}&day=gte.${filter.dayGte}&day=lt.${filter.dayLt}&select=day,question`,
    );
    for (const row of rows) {
      const key = `${row.day}|${row.question}`;
      if (!filter.keepKeys.has(key)) {
        await rest.delete(
          'noop_journal_entries',
          `user_id=eq.${filter.userId}&device_id=eq.${filter.deviceId}&day=eq.${row.day}&question=eq.${encodeURIComponent(row.question)}`,
        );
      }
    }
    return;
  }

  if (table === 'sessions') {
    const kinds = filter.kind === 'workout' ? ['workout', 'manual_workout'] : [filter.kind];
    const startIso = new Date(filter.startTsGte * 1000).toISOString();
    const endIso = new Date(filter.startTsLt * 1000).toISOString();
    for (const kind of kinds) {
      const rows = await rest.select(
        'sessions',
        `user_id=eq.${filter.userId}&kind=eq.${kind}&start_at=gte.${startIso}&start_at=lt.${endIso}&select=id,external_id`,
      );
      for (const row of rows) {
        if (!filter.keepKeys.has(row.external_id)) {
          await rest.delete('sessions', `id=eq.${row.id}`);
        }
      }
    }
  }
}
