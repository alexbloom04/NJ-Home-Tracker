// One-time (yearly) builder for data/schools.csv from the NJ DOE School Performance Reports.
//
// Usage:
//   node scripts/build_schools.mjs                 (downloads the latest district database)
//   node scripts/build_schools.mjs path/to/Database_DistrictStateDetail.xlsx
//
// Output columns: county,district_code,district,school_year,ela_pct,math_pct,score
//   ela_pct / math_pct = % of all students who met or exceeded expectations on NJSLA
//   score              = 1-10 statewide percentile rank of the ELA+Math average (10 = top 10%)
//
// Needs `tar` (built into Windows 10+, macOS, Linux) to read the xlsx zip.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const YEAR = process.env.SPR_YEAR || '2024-2025';
const URL = `https://www.nj.gov/education/sprreports/download/DataFiles/${YEAR}/Database_DistrictStateDetail.xlsx`;

async function getWorkbook() {
  if (process.argv[2]) return resolve(process.argv[2]);
  const dir = join(ROOT, 'data', 'raw');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `spr_district_${YEAR}.xlsx`);
  if (!existsSync(file)) {
    console.log(`Downloading ${URL} (~120 MB)...`);
    const res = await fetch(URL);
    if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return file;
}

// On Windows use the built-in bsdtar (Git Bash's GNU tar treats "C:" as a remote host)
const winTar = process.platform === 'win32' && join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const TAR = winTar && existsSync(winTar) ? winTar : 'tar';
const unzip = (file, member) =>
  execFileSync(TAR, ['-xOf', file, member], { maxBuffer: 1 << 30 }).toString('utf8');

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

function sheetPaths(file) {
  const wb = unzip(file, 'xl/workbook.xml');
  const rels = unzip(file, 'xl/_rels/workbook.xml.rels');
  const target = {};
  for (const m of rels.matchAll(/<Relationship [^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) target[m[1]] = m[2];
  const out = {};
  for (const m of wb.matchAll(/<sheet [^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    out[decode(m[1])] = 'xl/' + target[m[2]].replace(/^\/?xl\//, '');
  }
  return out;
}

function readRows(file, member, strings) {
  const xml = unzip(file, member);
  const rows = [];
  for (const r of xml.matchAll(/<row [^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const body = c[3] || '';
      let val = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1] ?? '';
      if (/t="s"/.test(c[2])) val = strings[+val];
      else if (/t="inlineStr"/.test(c[2])) val = (body.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] ?? '';
      row[c[1]] = decode(val);
    }
    rows.push(row);
  }
  // Find the header row (has CountyCode) and map columns -> names
  const hi = rows.findIndex((r) => Object.values(r).includes('CountyCode'));
  const header = rows[hi];
  return rows.slice(hi + 1).map((r) => Object.fromEntries(Object.entries(header).map(([col, name]) => [name, r[col]])));
}

const pct = (s) => {
  const n = parseFloat(String(s ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : null;
};

const file = await getWorkbook();
console.log('Reading', file);
const strings = [...unzip(file, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
  [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join('')
);
const sheets = sheetPaths(file);

function latestBySubject(sheetName) {
  const rows = readRows(file, sheets[sheetName], strings).filter((r) => r.StudentGroup === 'All Students');
  const latest = rows.map((r) => r.SchoolYear).sort().at(-1);
  const out = {};
  for (const r of rows) {
    if (r.SchoolYear !== latest) continue;
    // Only regular public districts: skip charters (county 80) and county-wide special districts
    if (r.CountyCode === '80' || /vocational|special services|educational services|commission|jointure/i.test(r.DistrictName)) continue;
    out[`${r.CountyCode}-${r.DistrictCode}`] = { r, v: pct(r.MetExceededExpectations_District) };
  }
  return { latest, out };
}

const ela = latestBySubject('ELAParticipationPerformance');
const math = latestBySubject('MathParticipationPerformance');

const districts = [];
for (const [key, e] of Object.entries(ela.out)) {
  const m = math.out[key];
  const vals = [e.v, m?.v].filter((v) => v != null);
  if (!vals.length) continue;
  districts.push({
    county: e.r.CountyName,
    district_code: `${e.r.CountyCode}-${e.r.DistrictCode}`,
    district: e.r.DistrictName,
    school_year: ela.latest,
    ela_pct: e.v,
    math_pct: m?.v ?? null,
    avg: vals.reduce((a, b) => a + b, 0) / vals.length,
  });
}

// Percentile rank -> 1..10
const sorted = [...districts].sort((a, b) => a.avg - b.avg);
sorted.forEach((d, i) => (d.score = Math.min(10, Math.floor((i / sorted.length) * 10) + 1)));

const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const cols = ['county', 'district_code', 'district', 'school_year', 'ela_pct', 'math_pct', 'score'];
const csv = [cols.join(','), ...districts.sort((a, b) => a.county.localeCompare(b.county) || a.district.localeCompare(b.district)).map((d) => cols.map((c) => esc(d[c])).join(','))].join('\n');
writeFileSync(join(ROOT, 'data', 'schools.csv'), csv + '\n');
console.log(`Wrote data/schools.csv: ${districts.length} districts, school year ${ela.latest}`);
