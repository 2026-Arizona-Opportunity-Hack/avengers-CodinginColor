import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';

// These digests pin the independently reviewed read-only catalog, not credentials.
const OWNER_CATALOG_SHA256 = 'c36e6cba2eff557489df35c6a1ccc6d7a94d69324323395c386b87636d6a156f';
const SECDEF_CATALOG_SHA256 = '101fc8556bfd099201ec8fa94bfb462f8c6db996149b90376c829e2994bfe7e3';
const HISTORICAL_013 = '3ebb968ff0f7c6dadb2e0130cd745f447207a9797f550eb97b0c46f8cbac36c5';
const CANONICAL_013 = '292c4187d724bc874c4adbf8110fe394bdac2e97c8f460195282c9c4ca64c5be';
const CANONICAL_018 = '552e2f2e1a5d63cc446e29c1b3b17e3eb6b5a289f5099541836d508180d9ba68';
const oldName = '013_staff_invitations.sql';
const newName = '018_staff_invitation_provider_status.sql';
const hash = s => createHash('sha256').update(s).digest('hex');
const lf = s => s.replaceAll('\r\n','\n');
const variants = s => new Set([hash(s),hash(lf(s)),hash(lf(s).replaceAll('\n','\r\n'))]);
const identifier = s => '"' + s.replaceAll('"','""') + '"';
const aclOrder = value => typeof value === 'string' && value.startsWith('{') ? `{${value.slice(1,-1).split(',').sort().join(',')}}` : value;
const stable = x => JSON.stringify(x, (key,value) => key === 'proacl' ? aclOrder(value) : value).replaceAll('\\r\\n','\\n');
const targets = {
  cic_assignment: ['admin_members()', 'assignable_owners()', 'claim_staff_invitation(text,uuid,text)',
    'create_assigned_donor(text,text,text,text,jsonb)', 'create_donor_once(uuid,text,text,text,text,jsonb)',
    'manage_member(uuid,text,text,boolean)', 'pending_staff_invitation(text)', 'reassign_donor(uuid,uuid)'],
  cic_reporting: ['cic_reporting_gifts(text,timestamp with time zone,timestamp with time zone)',
    'cic_reporting_programs(text)', 'cic_reporting_recent(text,integer)'],
  cic_impact: ['donor_impact_feed(integer,integer)'],
};
const queries={ actor:'SELECT current_user,session_user',
  ledger:'SELECT name,sha256 FROM schema_migrations ORDER BY name',
  table:`SELECT c.relname,pg_get_userbyid(c.relowner) owner,c.relacl,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c WHERE c.oid='public.staff_invitations'::regclass`,
  columns:`SELECT attname,format_type(atttypid,atttypmod) type,attnotnull,attacl,pg_get_expr(d.adbin,d.adrelid) default_value FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum WHERE a.attrelid='public.staff_invitations'::regclass AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
  constraints:`SELECT conname,pg_get_constraintdef(oid) definition FROM pg_constraint WHERE conrelid='public.staff_invitations'::regclass ORDER BY conname`,
  indexes:`SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='staff_invitations' ORDER BY indexname`,
  policies:`SELECT * FROM pg_policies WHERE schemaname='public' AND tablename='staff_invitations' ORDER BY policyname`,
  functions:`SELECT p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.proacl,p.prosecdef,p.proconfig,pg_get_functiondef(p.oid) definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('pending_staff_invitation','claim_staff_invitation') ORDER BY signature`,
  dependencies:`SELECT d.classid::regclass::text catalog,d.objid,d.objsubid,d.refclassid::regclass::text refcatalog,d.refobjid,d.refobjsubid,d.deptype FROM pg_depend d WHERE (d.classid='pg_proc'::regclass AND d.objid IN (SELECT oid FROM pg_proc WHERE proname IN ('pending_staff_invitation','claim_staff_invitation'))) OR (d.refclassid='pg_proc'::regclass AND d.refobjid IN (SELECT oid FROM pg_proc WHERE proname IN ('pending_staff_invitation','claim_staff_invitation')))`,
  roles:`SELECT rolname,rolsuper,rolinherit,rolcreaterole,rolcreatedb,rolcanlogin,rolreplication,rolbypassrls FROM pg_roles WHERE rolname IN ('cic_runtime','cic_assignment','cic_reporting','cic_impact',current_user) ORDER BY rolname`,
  memberships:`SELECT pg_get_userbyid(roleid) role,pg_get_userbyid(member) member,pg_get_userbyid(grantor) grantor,admin_option,inherit_option,set_option FROM pg_auth_members WHERE roleid IN (SELECT oid FROM pg_roles WHERE rolname IN ('cic_runtime','cic_assignment','cic_reporting','cic_impact')) ORDER BY role,member`,
  schema:`SELECT nspname,pg_get_userbyid(nspowner) owner,nspacl FROM pg_namespace WHERE nspname='public'`,
 };

const secdefQuery = `SELECT p.oid::regprocedure::text signature,pg_get_userbyid(p.proowner) owner,p.proacl,p.proconfig,pg_get_functiondef(p.oid) definition,
 EXISTS(SELECT FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee=0 AND a.privilege_type='EXECUTE') public_execute
 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.prosecdef ORDER BY signature`;
async function catalog(client) {
  const result = {};
  for (const [name,sql] of Object.entries(queries)) result[name] = (await client.query(sql)).rows;
  return result;
}
async function secdefs(client) { return (await client.query(secdefQuery)).rows; }
function compare(actual, expected, label) {
  if (stable(actual) !== stable(expected)) throw new Error(`Unexpected ${label}`);
}
function validateFiles(files, oldSource, beforeLedger) {
  const names = Object.keys(files).sort();
  if (names.length !== 18 || names.some((n,i) => !n.startsWith(`${String(i+1).padStart(3,'0')}_`)) ||
      names[12] !== oldName || names[17] !== newName || hash(lf(oldSource)) !== HISTORICAL_013 ||
      hash(lf(files[oldName])) !== CANONICAL_013 || hash(lf(files[newName])) !== CANONICAL_018 ||
      beforeLedger.length !== 17 || beforeLedger.some((row,i) => row.name !== names[i] ||
        !variants(row.name === oldName ? oldSource : files[row.name]).has(row.sha256))) throw new Error('Unexpected migration sources or ledger');
}
function expectedAfter(owner, functions, files) {
  const targetNames = Object.values(targets).flat();
  const afterOwner = structuredClone(owner), afterFunctions = structuredClone(functions);
  if (afterFunctions.length !== 13 || targetNames.length !== 12) throw new Error('Unexpected function inventory');
  for (const [role,names] of Object.entries(targets)) for (const name of names) {
    const entry = afterFunctions.find(f => f.signature === name);
    if (!entry || entry.owner !== role || entry.public_execute !== true ||
        aclOrder(entry.proacl) !== aclOrder(`{=X/${role},${role}=X/${role}}`)) throw new Error('Unexpected function ACL baseline');
    entry.proacl = `{${role}=X/${role},cic_runtime=X/${role}}`;
    entry.public_execute = false;
    const invitation = afterOwner.functions.find(f => f.signature === name);
    if (invitation) invitation.proacl = entry.proacl;
  }
  afterOwner.ledger[12].sha256 = hash(lf(files[oldName]));
  afterOwner.ledger.push({name:newName,sha256:hash(lf(files[newName]))});
  return {owner:afterOwner,functions:afterFunctions};
}

// Exact catalog digests pin the authorized one-time repair; no live connection is created here.
export async function repairInvitationHistory(client, files, historicalSource, ownerPath, secdefPath, backupPath) {
  const ownerRaw = await readFile(ownerPath), secdefRaw = await readFile(secdefPath);
  if (hash(ownerRaw) !== OWNER_CATALOG_SHA256 || hash(secdefRaw) !== SECDEF_CATALOG_SHA256) throw new Error('Unapproved catalog baseline');
  const owner = JSON.parse(ownerRaw), functions = JSON.parse(secdefRaw);
  validateFiles(files, historicalSource, owner.ledger);
  const after = expectedAfter(owner, functions, files);
  const actor = owner.actor?.[0]?.current_user;
  if (!actor || owner.actor[0].session_user !== actor) throw new Error('Unexpected actor');
  for (const role of Object.keys(targets)) {
    const rows = owner.memberships.filter(m => m.role === role && m.member === actor);
    if (rows.length !== 1 || !rows[0].admin_option || rows[0].inherit_option || rows[0].set_option || rows[0].grantor === actor)
      throw new Error('Unexpected owner membership');
  }
  const notices = [];
  const onNotice = notice => notices.push(notice);
  client.on('notice', onNotice);
  await client.query('SELECT pg_advisory_lock(467829001::bigint)');
  let begun = false;
  try {
    await client.query('BEGIN'); begun = true;
    await client.query('LOCK TABLE schema_migrations IN SHARE ROW EXCLUSIVE MODE');
    const currentOwner = await catalog(client), currentFunctions = await secdefs(client);
    if (stable(currentOwner) === stable(after.owner) && stable(currentFunctions) === stable(after.functions)) {
      await client.query('ROLLBACK'); begun = false; return 'already_applied';
    }
    compare(currentOwner, owner, 'catalog'); compare(currentFunctions, functions, 'function catalog');
    const ledger = (await client.query('SELECT name,sha256,applied_at FROM schema_migrations ORDER BY name')).rows;
    await writeFile(backupPath, JSON.stringify(ledger,null,2), {flag:'wx',mode:0o600});
    for (const [role,names] of Object.entries(targets)) {
      await client.query(`GRANT ${identifier(role)} TO ${identifier(actor)} WITH ADMIN FALSE, INHERIT FALSE, SET TRUE`);
      await client.query(`SET LOCAL ROLE ${identifier(role)}`);
      for (const name of names) {
        await client.query(`REVOKE ALL ON FUNCTION public.${name} FROM PUBLIC`);
        await client.query(`GRANT EXECUTE ON FUNCTION public.${name} TO cic_runtime`);
      }
      await client.query('RESET ROLE');
      await client.query(`REVOKE ${identifier(role)} FROM ${identifier(actor)} GRANTED BY ${identifier(actor)}`);
    }
    if (notices.length) throw new Error('Unexpected PostgreSQL notice');
    const updated = await client.query('UPDATE schema_migrations SET sha256=$1 WHERE name=$2 AND sha256=$3 RETURNING name',
      [hash(lf(files[oldName])),oldName,owner.ledger[12].sha256]);
    if (updated.rows.length !== 1) throw new Error('Unexpected 013 update count');
    const inserted = await client.query('INSERT INTO schema_migrations(name,sha256) VALUES($1,$2) RETURNING name',
      [newName,hash(lf(files[newName]))]);
    if (inserted.rows.length !== 1) throw new Error('Unexpected 018 insert count');
    compare(await catalog(client), after.owner, 'final catalog'); compare(await secdefs(client), after.functions, 'final function catalog');
    if (notices.length) throw new Error('Unexpected PostgreSQL notice');
    await client.query('COMMIT'); begun = false; return 'repaired';
  } catch (error) { if (begun) await client.query('ROLLBACK'); throw error; }
  finally { client.off('notice',onNotice); await client.query('SELECT pg_advisory_unlock(467829001::bigint)'); }
}
