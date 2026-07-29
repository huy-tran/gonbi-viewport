import {
  DEVICES,
  searchText,
  byYearDesc,
  exactNameBoost,
} from '../src/data/devices.js';
import { fuzzyFilter } from '../src/lib/fuzzy.js';

const rank = (q) => fuzzyFilter(q, DEVICES, searchText, byYearDesc, exactNameBoost);

const queries = [
  'ip15p',
  'iphone',
  'gs24',
  'galaxy tab',
  'macbook',
  'mba',
  'pixel',
  'ipad',
  '15 pro max',
  'watch',
  'nord',
  'iphone 15 pro',
  'zzzz',
];

for (const q of queries) {
  const top = rank(q)
    .slice(0, 4)
    .map((r) => `${r.item.brand} ${r.item.name} (${Math.round(r.score)})`);
  console.log(`${q.padEnd(14)} -> ${top.length ? top.join(' | ') : 'NO MATCH'}`);
}

let failures = 0;
for (const d of DEVICES) {
  if (rank(d.name)[0]?.item.id !== d.id) {
    failures++;
    console.log(`  name "${d.name}" ranks ${rank(d.name)[0]?.item.name} first`);
  }
}
console.log(`\nself-match failures: ${failures}/${DEVICES.length}`);
