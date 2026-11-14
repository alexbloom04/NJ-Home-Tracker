// Generates fake listings in site/data so the dashboard can be previewed before the
// first real fetch. Real runs (scripts/build.py) overwrite these files.
//   node scripts/make_sample.mjs

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'site', 'data');

let seed = 42;
const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const pick = (a) => a[Math.floor(rand() * a.length)];
const between = (a, b) => a + rand() * (b - a);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const iso = (d) => d.toISOString().slice(0, 10);
const daysAgo = (n) => iso(new Date(Date.now() - n * 864e5));

// town, county, district_code, lat, lng, price level
const TOWNS = [
  ['Summit', 'Union', '39-5090', 40.716, -74.364, 1.9], ['Westfield', 'Union', '39-5730', 40.659, -74.347, 1.6],
  ['Cranford', 'Union', '39-0980', 40.658, -74.300, 1.1], ['Scotch Plains', 'Union', '39-4670', 40.655, -74.389, 1.1],
  ['Short Hills', 'Essex', '13-3190', 40.747, -74.325, 2.4], ['Montclair', 'Essex', '13-3310', 40.826, -74.209, 1.4],
  ['Livingston', 'Essex', '13-2730', 40.796, -74.315, 1.5], ['Maplewood', 'Essex', '13-4900', 40.731, -74.273, 1.2],
  ['Morristown', 'Morris', '27-3385', 40.797, -74.481, 1.1], ['Chatham', 'Morris', '27-0785', 40.741, -74.384, 1.7],
  ['Madison', 'Morris', '27-2870', 40.760, -74.417, 1.5], ['Randolph', 'Morris', '27-4330', 40.848, -74.581, 1.0],
  ['Parsippany', 'Morris', '27-3950', 40.858, -74.426, 0.85], ['Basking Ridge', 'Somerset', '35-0350', 40.706, -74.549, 1.4],
  ['Bridgewater', 'Somerset', '35-0555', 40.594, -74.604, 1.0], ['Hillsborough', 'Somerset', '35-2170', 40.497, -74.674, 0.95],
  ['Ridgewood', 'Bergen', '03-4390', 40.979, -74.116, 1.6], ['Glen Rock', 'Bergen', '03-1760', 40.963, -74.133, 1.4],
  ['Paramus', 'Bergen', '03-3930', 40.944, -74.075, 1.2], ['Edison', 'Middlesex', '23-1290', 40.519, -74.412, 0.85],
  ['Princeton', 'Mercer', '21-4255', 40.357, -74.667, 1.8], ['Holmdel', 'Monmouth', '25-2230', 40.345, -74.184, 1.3],
  ['Wayne', 'Passaic', '31-5570', 40.925, -74.276, 0.95], ['Whitehouse Station', 'Hunterdon', '19-4350', 40.615, -74.770, 0.8],
];
const STREETS = ['Oak', 'Maple', 'Elm', 'Prospect', 'Highland', 'Hillside', 'Park', 'Ridge', 'Forest', 'Summit', 'Valley', 'Woodland', 'Lincoln', 'Fairview', 'Orchard'];
const SUFFIX = ['St', 'Ave', 'Rd', 'Dr', 'Ln', 'Pl', 'Ct', 'Way'];
const TYPES = ['SINGLE_FAMILY', 'SINGLE_FAMILY', 'SINGLE_FAMILY', 'TOWNHOMES', 'CONDOS', 'MULTI_FAMILY'];

const schools = {};
for (const line of readFileSync(join(ROOT, 'data', 'schools.csv'), 'utf8').trim().split('\n').slice(1)) {
  const m = line.match(/^([^,]*),([^,]*),("(?:[^"]|"")*"|[^,]*),([^,]*),([^,]*),([^,]*),([^,]*)$/);
  if (m) schools[m[2]] = { district: m[3].replace(/^"|"$/g, ''), ela: +m[5], math: +m[6], score: +m[7] };
}

// Inline SVG "photos" so the sample has images without hotlinking anything
const photo = (hue, i) => 'data:image/svg+xml;utf8,' + encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="480"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,72%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},40%,45%)"/></linearGradient></defs><rect width="640" height="480" fill="url(#g)"/><path d="M200 300 L320 190 L440 300 Z" fill="rgba(255,255,255,.85)"/><rect x="230" y="300" width="180" height="110" fill="rgba(255,255,255,.85)"/><rect x="300" y="340" width="40" height="70" fill="hsl(${hue},30%,40%)"/><text x="20" y="460" font-family="sans-serif" font-size="22" fill="#fff">Sample photo ${i + 1}</text></svg>`);

const homes = [], details = {}, events = [];
let id = 1000;
for (const [town, county, code, lat, lng, lvl] of TOWNS) {
  const sc = schools[code];
  const n = Math.round(between(40, 90));
  details[slug(town)] = {};
  for (let i = 0; i < n; i++) {
    const r = rand();
    const st = r < 0.32 ? 'A' : r < 0.52 ? 'P' : 'S';
    const beds = Math.round(between(2, 6));
    const sqft = Math.round(between(900, 1000 + beds * 650) / 10) * 10;
    const lp = Math.round((between(260, 340) * sqft * lvl) / 5000) * 5000;
    const dom = Math.round(between(3, st === 'A' ? 90 : 45));
    const ld = daysAgo(st === 'S' ? Math.round(between(20, 200)) : dom);
    const sd = st === 'S' ? daysAgo(Math.round(between(0, 175))) : null;
    const sp = st === 'S' ? Math.round((lp * between(0.95, 1.14)) / 1000) * 1000 : null;
    const pd = st === 'P' ? daysAgo(Math.round(between(0, 30))) : null;
    const drop = st === 'A' && rand() < 0.15 ? Math.round(between(1, 6)) * 10000 : null;
    const hue = Math.floor(rand() * 360);
    const h = {
      id: String(id++), st, sub: st === 'P' && rand() < 0.4 ? 'CONTINGENT' : null,
      addr: `${Math.round(between(1, 400))} ${pick(STREETS)} ${pick(SUFFIX)}`, unit: null,
      city: town, zip: '07' + String(Math.round(between(0, 999))).padStart(3, '0'), county,
      lat: +(lat + between(-0.02, 0.02)).toFixed(5), lng: +(lng + between(-0.025, 0.025)).toFixed(5),
      lp, sp, sd, ld, pd, beds, baths: Math.round(between(1, beds) * 2) / 2 + 0.5, sqft,
      lot: Math.round(between(4000, 40000)), yb: Math.round(between(1900, 2023)), dom, type: pick(TYPES),
      img: photo(hue, 0), sc: sc?.score ?? null, new: st === 'A' && dom <= 7 ? 1 : 0, drop, fs: ld,
    };
    homes.push(h);
    details[slug(town)][h.id] = {
      photos: Array.from({ length: 5 }, (_, k) => photo((hue + k * 25) % 360, k)),
      desc: `Sample listing in ${town}. ${beds} bedrooms with an updated kitchen, hardwood floors and a fenced yard. Close to schools, parks and NJ Transit.`,
      tax: Math.round(lp * between(0.017, 0.026)), hoa: h.type === 'CONDOS' ? Math.round(between(250, 600)) : null,
      est: Math.round((lp * between(0.95, 1.08)) / 1000) * 1000, assessed: Math.round(lp * 0.6), stories: Math.round(between(1, 3)),
      garage: Math.round(between(0, 3)) || null, new_build: false, schools_near: null, url: null, mls: `SAMPLE${h.id}`,
      ph: drop ? [[daysAgo(dom), lp + drop], [daysAgo(Math.round(dom / 2)), lp]] : [[ld, lp]],
      district: sc?.district ?? null, ela: sc?.ela ?? null, math: sc?.math ?? null,
    };
    const ev = { id: h.id, addr: h.addr, city: town, lp, img: h.img };
    if (h.new) events.push({ ...ev, d: ld, type: 'new' });
    if (st === 'P' && pd >= daysAgo(14)) events.push({ ...ev, d: pd, type: 'pending' });
    if (st === 'S' && sd >= daysAgo(14)) events.push({ ...ev, d: sd, type: 'sold', sp });
    if (drop && rand() < 0.5) events.push({ ...ev, d: daysAgo(Math.round(dom / 2)), type: 'price', old: lp + drop });
  }
}
events.sort((a, b) => b.d.localeCompare(a.d));

const history = [];
for (let d = 20; d >= 0; d--) {
  history.push({ d: daysAgo(d), town: 'All', active: Math.round(homes.filter((h) => h.st === 'A').length * (1 + (d - 10) * 0.008 + between(-0.02, 0.02))), pending: Math.round(homes.filter((h) => h.st === 'P').length * (1 + between(-0.03, 0.03))) });
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(join(OUT, 'details'), { recursive: true });
const w = (f, o) => writeFileSync(join(OUT, f), JSON.stringify(o));
w('listings.json', homes);
w('towns.json', TOWNS.map(([town, county, code]) => ({ town, county, slug: slug(town), district: schools[code]?.district ?? null, sc: schools[code]?.score ?? null })));
w('changes.json', events);
w('history.json', history);
w('meta.json', { updated: daysAgo(0), sample: true, counties: [...new Set(TOWNS.map((t) => t[1]))], sold_days: 180, new_days: 7, counts: {} });
for (const [s, rows] of Object.entries(details)) w(`details/${s}.json`, rows);
console.log(`Sample data: ${homes.length} homes in ${TOWNS.length} towns`);
