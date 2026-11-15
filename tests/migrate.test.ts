import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { PGlite } from '@electric-sql/pglite';
import { migrate } from '../db/migrate.ts';

test('ambiguous migration versions and unwrapped SQL fail before database changes', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-migrate-'));
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-migrate-'))));
    await rm(directory, { recursive: true });
  });
  const client = { query: async () => assert.fail('Invalid migration reached the database') };
  for (const [files, message] of [
    [['example.sql'], /unique numbered/],
    [['001_first.sql', '001_second.sql'], /unique numbered/],
    [['001_unwrapped.sql'], /wrapped in BEGIN\/COMMIT/],
  ] as const) {
    for (const file of files) await writeFile(join(directory, file), 'CREATE TABLE unsafe (id int);');
    await assert.rejects(migrate(client, directory), message);
    for (const file of files) await rm(join(directory, file));
  }
});

test('migration ledger applies once and rejects modified or missing applied SQL', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-migrate-'));
  const db = new PGlite();
  t.after(async () => {
    await db.close();
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-migrate-'))));
    await rm(directory, { recursive: true });
  });
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  const first = join(directory, '001_example.sql');
  await writeFile(first, 'BEGIN; CREATE TABLE example (id int); COMMIT;');
  assert.deepEqual(await migrate(client, directory), ['001_example.sql']);
  assert.deepEqual((await db.query("SELECT table_schema FROM information_schema.tables WHERE table_name = 'example'")).rows,
    [{ table_schema: 'public' }]);
  assert.deepEqual(await migrate(client, directory), []);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 1);
  const older = join(directory, '000_older.sql');
  await writeFile(older, 'BEGIN; CREATE TABLE older (id int); COMMIT;');
  await assert.rejects(migrate(client, directory), /out of order/);
  await rm(older);
  await writeFile(first, 'BEGIN; DROP TABLE example; COMMIT;');
  await assert.rejects(migrate(client, directory), /Modified applied migration/);
  await rm(first);
  await assert.rejects(migrate(client, directory), /Applied migration missing/);
  assert.equal((await db.query('SELECT * FROM example')).rows.length, 0);
});

test('failed migration rolls back its writes and ledger; corrected pending SQL retries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-migrate-'));
  const db = new PGlite();
  t.after(async () => {
    await db.close();
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-migrate-'))));
    await rm(directory, { recursive: true });
  });
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  await writeFile(join(directory, '001_example.sql'), 'BEGIN; CREATE TABLE example (id int); COMMIT;');
  const pending = join(directory, '002_insert.sql');
  await writeFile(pending, 'BEGIN; INSERT INTO example VALUES (7); SELECT nonexistent_function(); COMMIT;');
  await assert.rejects(migrate(client, directory));
  assert.equal((await db.query('SELECT * FROM example')).rows.length, 0);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 1);
  await writeFile(pending, 'BEGIN; INSERT INTO example VALUES (7); COMMIT;');
  assert.deepEqual(await migrate(client, directory), ['002_insert.sql']);
  assert.deepEqual((await db.query('SELECT * FROM example')).rows, [{ id: 7 }]);
});

test('inner COMMIT cannot persist unrecorded writes; procedural BEGIN remains valid', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-migrate-'));
  const db = new PGlite();
  t.after(async () => {
    await db.close();
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-migrate-'))));
    await rm(directory, { recursive: true });
  });
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values)
    : (await db.exec(sql)).at(-1)! };
  const pending = join(directory, '001_partial.sql');
  await writeFile(pending, 'BEGIN; CREATE TABLE partial_commit (id int); COMMIT; SELECT missing_function(); COMMIT;');
  await assert.rejects(migrate(client, directory));
  assert.equal((await db.query<{ name: string | null }>("SELECT to_regclass('partial_commit') AS name")).rows[0].name, null);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 0);
  await writeFile(pending, 'BEGIN; DO $$ BEGIN CREATE TABLE partial_commit (id int); END $$; COMMIT;');
  assert.deepEqual(await migrate(client, directory), ['001_partial.sql']);
  assert.equal((await db.query('SELECT * FROM schema_migrations')).rows.length, 1);
  assert.equal((await db.query('SELECT * FROM partial_commit')).rows.length, 0);
});
