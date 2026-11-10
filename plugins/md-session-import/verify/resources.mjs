import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const bundle = 'C:/Users/q1505/.dsh/plugins/md-session-import';

// 1. Every JSON resource parses as UTF-8 and round-trips.
for (const name of readdirSync(join(bundle, 'locale'))) {
  const raw = readFileSync(join(bundle, 'locale', name));
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw new Error(`${name} carries a BOM`);
  const text = raw.toString('utf8');
  if (text.includes('\uFFFD')) throw new Error(`${name} is not valid UTF-8`);
  const parsed = JSON.parse(text);
  if (typeof parsed?.meta?.title !== 'string' || typeof parsed?.meta?.description !== 'string') {
    throw new Error(`${name} is missing meta.title or meta.description`);
  }
  console.log(`locale ${name}: ok  title=${JSON.stringify(parsed.meta.title)}`);
}

// 2. The client dictionaries carry the same key set as zh.
const client = readFileSync(join(bundle, 'client.js'), 'utf8');
const dicts = {};
for (const locale of ['zh', 'en', 'ja', 'es', 'fr', 'de', 'ru', 'pt']) {
  const start = client.indexOf(`const ${locale} = {`);
  if (start < 0) throw new Error(`client.js has no ${locale} dictionary`);
  const end = client.indexOf('\n\t\t};', start);
  const body = client.slice(start, end);
  const keys = [...body.matchAll(/'([a-zA-Z.]+)':/g)].map((m) => m[1]);
  dicts[locale] = keys;
}
const base = dicts.zh;
for (const [locale, keys] of Object.entries(dicts)) {
  const missing = base.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !base.includes(k));
  if (missing.length > 0 || extra.length > 0) throw new Error(`${locale} key mismatch: missing=${missing} extra=${extra}`);
}
console.log(`dictionaries: ${Object.keys(dicts).length} locales x ${base.length} keys, all matching zh`);
