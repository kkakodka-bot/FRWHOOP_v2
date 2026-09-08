import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const sql = readFileSync(
  new URL('../../supabase/migrations/20260907160000_noop_journal_entries.sql', import.meta.url),
  'utf8',
);

test('noop_journal_entries migration matches replace-window wire keys', () => {
  assert.match(sql, /create table if not exists public\.noop_journal_entries/);
  assert.match(sql, /primary key \(user_id, device_id, day, question\)/);
  assert.match(sql, /answered_yes boolean not null/);
  assert.match(sql, /replacement_id uuid not null/);
  assert.match(sql, /noop_journal_entries_select_own/);
  assert.match(sql, /noop_journal_entries_service_write/);
});
