import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { createRequire } from 'node:module';
import { Unzip, UnzipInflate, zipSync } from 'fflate';
import readXlsxFile from 'read-excel-file/node';
import { previewCsv } from './import-preview.ts';

type SaxParser = { on(event: string, listener: (...args: any[]) => void): void; parse(xml: string): unknown };
// saxen ships no type declarations; the reader uses the same parser internally.
const { Parser } = createRequire(import.meta.url)('saxen') as { Parser: new () => SaxParser };
type Attrs = Record<string, string>;
const MAX_BYTES = 5 * 1024 * 1024, MAX_ENTRIES = 256, MAX_ENTRY = 8 * 1024 * 1024;
const MAX_TOTAL = 16 * 1024 * 1024, MAX_ROWS = 20_001, MAX_COLS = 200;
const sources = ['spreadsheet', 'zeffy', 'benevity', 'az_gives', 'united_way'];
const decoder = new TextDecoder('utf-8', { fatal: true });
function fail(reason: string): never { throw new Error(`XLSX ${reason}`); }

function unzipBounded(bytes: Uint8Array): Map<string, Uint8Array> {
  // Require a complete ordinary ZIP directory; streaming local headers alone accept truncated archives.
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6 &&
        i + 22 + (bytes[i + 20] | bytes[i + 21] << 8) === bytes.length) { end = i; break; }
  }
  if (end < 0) fail('archive is invalid');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredEntries = view.getUint16(end + 10, true);
  const directoryEnd = view.getUint32(end + 16, true) + view.getUint32(end + 12, true);
  if (declaredEntries > MAX_ENTRIES || directoryEnd !== end ||
      view.getUint16(end + 8, true) !== declaredEntries) fail('archive is invalid');
  const entries = new Map<string, Uint8Array>(), seen = new Set<string>();
  let total = 0, problem: string | null = null;
  const unzip = new Unzip(file => {
    if (problem) return;
    if (file.name.startsWith('/') || file.name.includes('\\') ||
        file.name.split('/').includes('..') || entries.has(file.name) || seen.has(file.name)) {
      problem = 'archive is invalid'; return;
    }
    seen.add(file.name);
    if (seen.size > MAX_ENTRIES) { problem = 'archive exceeds safety limits'; return; }
    if (file.originalSize !== undefined && file.originalSize > MAX_ENTRY) {
      problem = 'archive exceeds safety limits'; return;
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    file.ondata = (error, chunk, final) => {
      if (problem) return;
      if (error) { problem = 'archive is invalid'; return; }
      size += chunk.length;
      total += chunk.length;
      if (size > MAX_ENTRY || total > MAX_TOTAL) { problem = 'archive exceeds safety limits'; return; }
      chunks.push(chunk);
      if (!final) return;
      const output = new Uint8Array(size);
      let offset = 0;
      for (const piece of chunks) { output.set(piece, offset); offset += piece.length; }
      entries.set(file.name, output);
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  try {
    // Small compressed chunks bound fflate's per-push inflated allocation before its ondata limit check.
    for (let i = 0; i < bytes.length && !problem; i += 512) {
      unzip.push(bytes.subarray(i, i + 512), i + 512 >= bytes.length);
    }
  } catch { problem ??= 'archive is invalid'; }
  if (problem) fail(problem);
  if (seen.size !== declaredEntries || entries.size !== declaredEntries) fail('archive is invalid');
  return entries;
}

function parseXml(text: string, onOpen?: (name: string, attrs: Attrs) => void): void {
  const parser = new Parser();
  let failure: Error | null = null;
  parser.on('error', (error: Error) => { failure ??= error; });
  parser.on('attention', (declaration: string) => {
    if (/^<!(?:DOCTYPE|ENTITY)\b/i.test(declaration.trim())) failure ??= new Error('XLSX contains unsupported XML declarations');
  });
  if (onOpen) parser.on('openTag', (name: string, getAttrs: () => Attrs) => {
    if (!failure) onOpen(name, getAttrs());
  });
  try { parser.parse(text); } catch (error) {
    failure ??= error instanceof Error ? error : new Error('XLSX contains invalid XML');
  }
  if (failure) throw failure.message.startsWith('XLSX ') ? failure : new Error('XLSX contains invalid XML');
}

function xml(entries: Map<string, Uint8Array>, path: string): string {
  const bytes = entries.get(path);
  if (!bytes) fail('is missing required parts');
  try { return decoder.decode(bytes).replace(/^\uFEFF/, ''); } catch { fail('contains invalid XML'); }
}

function checkRef(ref: string | undefined): void {
  const match = typeof ref === 'string' ? /^([A-Z]{1,3})([1-9]\d*)$/.exec(ref) : null;
  if (!match) fail('worksheet has an invalid cell reference');
  let column = 0;
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64;
  if (Number(match[2]) > MAX_ROWS || column > MAX_COLS) fail('worksheet exceeds safety limits');
}

function checkSheet(text: string): void {
  let formula = false;
  parseXml(text, (name, attrs) => {
    if (name === 'f') formula = true;
    else if (name === 'row') {
      if (!/^[1-9]\d*$/.test(attrs.r ?? '')) fail('worksheet has an invalid row reference');
      if (attrs.r.length > String(MAX_ROWS).length || Number(attrs.r) > MAX_ROWS) fail('worksheet exceeds safety limits');
    }
    else if (name === 'dimension') {
      const refs = String(attrs.ref ?? '').split(':');
      if (!refs.length || refs.length > 2) fail('worksheet has an invalid dimension');
      for (const ref of refs) checkRef(ref);
    } else if (name === 'c') {
      if (!attrs.r) fail('worksheet has a cell without a reference');
      checkRef(attrs.r);
    }
  });
  if (formula) fail('formulas are not supported; review the source file');
}

function resolveTarget(target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  if (!target || target.includes('\\') || target.includes('://') ||
      target.split('/').includes('..') || !/^xl\/[A-Za-z0-9._/-]+$/.test(path)) {
    fail('contains ambiguous relationships');
  }
  return path;
}

export async function previewXlsx(bytes: Uint8Array, source: string, file: string,
  columnMapping: unknown = {}, dateOptions?: unknown): Promise<ReturnType<typeof previewCsv>> {
  if (!file.toLowerCase().endsWith('.xlsx')) fail('only .xlsx files are supported');
  if (!(bytes instanceof Uint8Array) || !bytes.length || bytes.length > MAX_BYTES) {
    fail('must be a non-empty file of at most 5 MiB');
  }
  const entries = unzipBounded(bytes);
  for (const required of ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels']) {
    if (!entries.has(required)) fail('is missing required parts');
  }
  const sheets: { name?: string; state?: string; rid?: string }[] = [];
  parseXml(xml(entries, 'xl/workbook.xml'), (name, attrs) => {
    if (name === 'sheet') sheets.push({ name: attrs.name, state: attrs.state, rid: attrs['r:id'] });
  });
  if (sheets.length !== 1) fail('must contain exactly one visible worksheet');
  const only = sheets[0];
  if (!only.name || !only.rid || (only.state && only.state !== 'visible')) {
    fail('must contain exactly one visible worksheet');
  }
  const relations: { id: string; type: string; target: string; mode?: string }[] = [];
  parseXml(xml(entries, 'xl/_rels/workbook.xml.rels'), (name, attrs) => {
    if (name === 'Relationship') {
      relations.push({ id: attrs.Id ?? '', type: attrs.Type ?? '', target: attrs.Target ?? '', mode: attrs.TargetMode });
    }
  });
  const part = (suffix: string): string | undefined => {
    const found = relations.filter(relation => relation.type.endsWith(suffix));
    if (found.length > 1 || found[0]?.mode === 'External') fail('contains ambiguous relationships');
    return found[0] ? resolveTarget(found[0].target) : undefined;
  };
  const sheets_rel = relations.filter(relation => relation.type.endsWith('/worksheet'));
  if (sheets_rel.length !== 1 || sheets_rel[0].id !== only.rid) {
    fail('must contain exactly one worksheet relationship');
  }
  const sheetPath = resolveTarget(sheets_rel[0].target);
  for (const name of entries.keys()) {
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name) && name !== sheetPath) {
      fail('must contain exactly one worksheet');
    }
  }
  const stylePath = part('/styles') ?? (entries.has('xl/styles.xml') ? 'xl/styles.xml' : undefined);
  const stringPath = part('/sharedStrings') ?? (entries.has('xl/sharedStrings.xml') ? 'xl/sharedStrings.xml' : undefined);
  for (const path of [sheetPath, stylePath, stringPath]) {
    if (path && !entries.has(path)) fail('is missing required parts');
  }
  checkSheet(xml(entries, sheetPath));
  const kept = ['[Content_Types].xml', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', sheetPath,
    ...(stylePath ? [stylePath] : []), ...(stringPath ? [stringPath] : [])];
  // Re-zip only validated parts so the reader sees the same bytes the checks approved.
  const normalized = zipSync(Object.fromEntries(kept.map(path => [path, entries.get(path)!])));
  let parsed: Awaited<ReturnType<typeof readXlsxFile>>;
  try { parsed = await readXlsxFile(Buffer.from(normalized), { trim: false, parseNumber: text => text }); }
  catch (error) { throw error instanceof Error && error.message.startsWith('XLSX ') ? error : new Error('XLSX could not be read'); }
  if (parsed.length !== 1) fail('must contain exactly one visible worksheet');
  const rows = parsed[0].data;
  const text = (cell: unknown): string => cell === null || cell === undefined ? ''
    : typeof cell === 'string' ? cell : typeof cell === 'number' || typeof cell === 'boolean'
      ? String(cell) : fail('contains an unsupported cell value');
  if (!rows.length) fail('header is missing');
  for (const row of rows) if (row.some(cell => cell instanceof Date)) {
    fail('date-formatted cells are not supported; enter dates as text and confirm the format');
  }
  const headers = rows[0].map(text);
  if (!headers.some(value => value.trim())) fail('header is missing');
  const quote = (value: string) => /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
  const csv = rows.map(row => {
    const cells = row.map(text);
    while (cells.length < headers.length) cells.push('');
    return cells.map(quote).join(',');
  }).join('\n');
  return previewCsv(csv, source, file, columnMapping, dateOptions);
}

if (import.meta.main) {
  try {
    const [source, file, ...rest] = process.argv.slice(2);
    if (!source || !file || !file.toLowerCase().endsWith('.xlsx')) {
      throw new Error(`Usage: node tools/import-xlsx.ts <${sources.join('|')}> <file.xlsx> ` +
        '[mapping.json] [--date-format MM/DD/YYYY --utc-offset ±HH:MM]');
    }
    let mappingFile: string | undefined;
    const flags = new Map<string, string>();
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--date-format' || arg === '--utc-offset') {
        if (flags.has(arg) || i + 1 >= rest.length) throw new Error(`Missing or repeated value for ${arg}`);
        flags.set(arg, rest[++i]);
      } else if (arg.startsWith('--') || mappingFile) {
        // Unexpected values may be private paths or contacts; never echo them.
        throw new Error('Unexpected argument; see usage');
      } else mappingFile = arg;
    }
    if (mappingFile && !mappingFile.toLowerCase().endsWith('.json')) {
      throw new Error('Mapping file must be a .json file');
    }
    if (flags.size && flags.size !== 2) throw new Error('Both --date-format and --utc-offset are required together');
    const bytes = await readFile(file);
    let columnMapping: unknown = {};
    if (mappingFile) {
      const content = await readFile(mappingFile, 'utf8');
      if (Buffer.byteLength(content, 'utf8') > MAX_BYTES) throw new Error('Mapping exceeds 5 MiB');
      try { columnMapping = JSON.parse(content); }
      catch { throw new Error('Mapping file must contain valid JSON'); }
    }
    const dateOptions = flags.size ? { date_format: flags.get('--date-format')!, utc_offset: flags.get('--utc-offset')! } : undefined;
    const preview = await previewXlsx(bytes, source, basename(file), columnMapping, dateOptions);
    const issueCounts: Record<string, number> = {};
    for (const issue of preview.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    console.log(JSON.stringify({ source, status: preview.status,
      rowCount: preview.rows.length, issueCounts }, null, 2));
  } catch (error) {
    // Filesystem errors may contain private paths; only validation messages are safe to display.
    console.error(error instanceof Error && !('code' in error) ? error.message : 'Unable to read XLSX file');
    process.exitCode = 1;
  }
}
