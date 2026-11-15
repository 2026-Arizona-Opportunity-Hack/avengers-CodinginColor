import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

interface MigrationClient {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}

export async function migrate(client: MigrationClient, directory: string): Promise<string[]> {
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  if (files.some(name => !/^\d{3}_[a-z0-9_]+\.sql$/.test(name)) ||
      new Set(files.map(name => name.slice(0, 3))).size !== files.length) {
    throw new Error('Expected unique numbered SQL migrations');
  }
  const pending = await Promise.all(files.map(async name => {
    const source = await readFile(join(directory, name), 'utf8');
    // The runner owns the transaction so SQL changes and ledger entry commit together.
    const wrapped = /^\s*BEGIN;([\s\S]*)COMMIT;\s*$/.exec(source);
    if (!wrapped) throw new Error(`Migration must be wrapped in BEGIN/COMMIT: ${name}`);
    const hash = (text: string) => createHash('sha256').update(text).digest('hex');
    // Git may check out the same SQL with LF or CRLF. New ledger entries use LF;
    // retain exact legacy raw/LF/CRLF hashes without ignoring any other text edit.
    const lf = source.replace(/\r\n/g, '\n');
    const checksum = hash(lf);
    const acceptedChecksums = new Set([hash(source), checksum, hash(lf.replace(/\n/g, '\r\n'))]);
    return { name, sql: wrapped[1], checksum, acceptedChecksums };
  }));
  await client.query('SELECT pg_advisory_lock(467829001::bigint)');
  try {
    // SPI disallows transaction control inside migration SQL, including hidden inner COMMITs.
    await client.query(`CREATE OR REPLACE FUNCTION pg_temp.cic_apply_migration(migration_sql text)
      RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public, pg_catalog
      AS $$ BEGIN EXECUTE migration_sql; END; $$`);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const applied = (await client.query('SELECT name, sha256 FROM schema_migrations ORDER BY name')).rows;
    for (const previous of applied) {
      const file = pending.find(item => item.name === previous.name);
      if (!file) throw new Error(`Applied migration missing: ${previous.name}`);
      if (typeof previous.sha256 !== 'string' || !file.acceptedChecksums.has(previous.sha256)) throw new Error(`Modified applied migration: ${previous.name}`);
    }
    const latest = applied.at(-1)?.name;
    if (typeof latest === 'string' && pending.some(file => file.name < latest &&
        !applied.some(item => item.name === file.name))) {
      throw new Error('Pending migration is out of order');
    }
    const completed: string[] = [];
    for (const file of pending) {
      if (applied.some(item => item.name === file.name)) continue;
      await client.query('BEGIN');
      try {
        await client.query('SELECT pg_temp.cic_apply_migration($1)', [file.sql]);
        await client.query('INSERT INTO schema_migrations (name, sha256) VALUES ($1, $2)', [file.name, file.checksum]);
        await client.query('COMMIT');
        completed.push(file.name);
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    }
    return completed;
  } finally { await client.query('SELECT pg_advisory_unlock(467829001::bigint)'); }
}

if (import.meta.main) {
  let client: Client | undefined;
  try {
    const url = new URL(process.env.MIGRATION_DATABASE_URL ?? '');
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid migration connection');
    client = new Client({ connectionString: url.href, connectionTimeoutMillis: 10000 });
    await client.connect();
    const completed = await migrate(client, fileURLToPath(new URL('migrations/', import.meta.url)));
    console.log(`Applied ${completed.length} migration(s)`);
  } catch {
    // Driver errors can contain connection credentials or private SQL values.
    console.error('Migration failed; check the privileged connection and migration history. No credentials are logged.');
    process.exitCode = 1;
  } finally { await client?.end(); }
}
