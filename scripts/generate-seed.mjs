import fs from 'node:fs';
import banks from '../lib/default-wordbanks.js';
const literal = s => "'" + s.replaceAll("'", "''") + "'";
const sql = Object.values(banks).map(b => `select public.wodi_import(${literal(b.name)}, ${literal(JSON.stringify(b.pairs))}::jsonb);`).join('\n');
fs.writeFileSync('supabase/migrations/20261106000200_words.sql', '-- Initial 45 pairs in 3 themes; not included in the frontend bundle.\n' + sql + '\n');
