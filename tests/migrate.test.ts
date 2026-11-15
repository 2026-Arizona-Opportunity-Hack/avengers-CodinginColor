import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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


for (const originalEnding of ['\n', '\r\n']) {
  test(`legacy ${originalEnding === '\n' ? 'LF to CRLF' : 'CRLF to LF'} replay leaves applied schema and ledger unchanged`, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'cic-migrate-'));
    const db = new PGlite();
    t.after(async () => {
      await db.close();
      assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-migrate-'))));
      await rm(directory, { recursive: true });
    });
    const lf = 'BEGIN;\nCREATE TABLE newline_example (id int);\nINSERT INTO newline_example VALUES (7);\nCOMMIT;\n';
    const original = lf.replace(/\n/g, originalEnding);
    const legacyHash = createHash('sha256').update(original).digest('hex');
    // In-memory fixture represents an existing ledger written by the old raw-byte runner.
    await db.exec(original);
    await db.exec('CREATE TABLE schema_migrations(name text PRIMARY KEY,sha256 text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())');
    await db.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2)', ['001_example.sql', legacyHash]);
    const before = (await db.query('SELECT * FROM schema_migrations')).rows;
    const file = join(directory, '001_example.sql');
    await writeFile(file, lf.replace(/\n/g, originalEnding === '\n' ? '\r\n' : '\n'));
    const queries: string[] = [];
    const client = { query: async (sql: string, values?: unknown[]) => {
      queries.push(sql);
      return values ? db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)!;
    } };
    assert.deepEqual(await migrate(client, directory), []);
    assert.ok(!queries.some(sql => sql === 'BEGIN' || sql.startsWith('SELECT pg_temp.cic_apply_migration(')
      || /^(?:INSERT INTO|UPDATE) schema_migrations/.test(sql)), 'Replay must not apply migration SQL or write the ledger');
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations')).rows, before);
    assert.deepEqual((await db.query('SELECT * FROM newline_example')).rows, [{ id: 7 }]);
    await writeFile(file, lf.replace('VALUES (7)', 'VALUES (8)'));
    await assert.rejects(migrate(client, directory), /Modified applied migration/);
    assert.deepEqual((await db.query('SELECT * FROM schema_migrations')).rows, before);
    assert.deepEqual((await db.query('SELECT * FROM newline_example')).rows, [{ id: 7 }]);
  });
}

test('new migration checksums use LF and do not treat other text changes as newline conversion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'cic-migrate-'));
  const db = new PGlite();
  t.after(async () => {
    await db.close();
    assert.ok(resolve(directory).startsWith(resolve(join(tmpdir(), 'cic-migrate-'))));
    await rm(directory, { recursive: true });
  });
  const client = { query: async (sql: string, values?: unknown[]) => values
    ? db.query<Record<string, unknown>>(sql, values) : (await db.exec(sql)).at(-1)! };
  const lf = 'BEGIN;\nCREATE TABLE canonical_example (id int);\nCOMMIT;\n';
  const file = join(directory, '001_example.sql');
  await writeFile(file, lf.replace(/\n/g, '\r\n'));
  assert.deepEqual(await migrate(client, directory), ['001_example.sql']);
  assert.equal((await db.query<{sha256:string}>('SELECT sha256 FROM schema_migrations')).rows[0].sha256,
    createHash('sha256').update(lf).digest('hex'));
  await writeFile(file, lf);
  assert.deepEqual(await migrate(client, directory), []);
  for (const changed of [lf.replace('id int', 'id  int'), lf + '\n', lf.replace('\nCREATE', '\rCREATE')]) {
    await writeFile(file, changed);
    await assert.rejects(migrate(client, directory), /Modified applied migration/);
  }
});
