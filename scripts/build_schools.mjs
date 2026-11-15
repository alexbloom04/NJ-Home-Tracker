// One-time (yearly) builder for data/schools.csv from the NJ DOE School Performance Reports.
//
// Usage:
//   node scripts/build_schools.mjs                 (downloads the latest district database)
//   node scripts/build_schools.mjs path/to/Database_DistrictStateDetail.xlsx
//
// Output columns: county,district_code,district,school_year,ela_pct,math_pct,score,
//                 elem_pct,elem_score,mid_pct,mid_score,high_pct,high_score
//   ela_pct / math_pct = % of all students who met or exceeded expectations on NJSLA
//   score              = 1-10 statewide percentile rank of the ELA+Math average (10 = top 10%)
//   elem / mid / high  = the same idea per school level, each ranked among districts with that level:
//     elementary = ELA + Math grades 3-5
//     middle     = ELA grades 6-8 + Math grades 6-7 (grade 8 math is skipped: strong students
//                  take Algebra I instead, which makes it look low in top districts)
//     high       = NJGPA grade 11 ELA + Math "graduation ready" (taken by all juniors)
//   Rates are averaged weighted by the number of test takers.
//
// Also writes site/schools.json for the dashboard: per district (keyed "name|county"), the
// elementary, middle and high school scores its students get, following data/sending.csv for
// districts that send middle or high schoolers to another (regional) district.
//
// Needs `tar` (built into Windows 10+, macOS, Linux) to read the xlsx zip.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
const rank = (list, key, out) => {
  const s = list.filter((d) => d[key] != null).sort((a, b) => a[key] - b[key]);
  s.forEach((d, i) => (d[out] = Math.min(10, Math.floor((i / s.length) * 10) + 1)));
};
rank(districts, 'avg', 'score');

// ---------------------------------------------------------------- per school level
// "<10%" is reported for very low rates; "Fewer than 10 testers" means no data.
const rate = (s) => {
  const t = String(s ?? '').trim();
  if (/^<\s*10/.test(t)) return 5;
  if (/^>\s*90/.test(t)) return 95;
  return pct(t);
};
const count = (s) => {
  const n = parseFloat(String(s ?? '').replace(/,/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
};
const LEVEL_TESTS = {
  elem: { ELA: ['Grade 3', 'Grade 4', 'Grade 5'], Math: ['Grade 3', 'Grade 4', 'Grade 5'] },
  mid: { ELA: ['Grade 6', 'Grade 7', 'Grade 8'], Math: ['Grade 6', 'Grade 7'] },
};
const acc = {}; // district_code -> level -> [sum of rate*n, sum of n]
const add = (code, level, r, n) => {
  if (r == null || n == null) return;
  const a = ((acc[code] ||= {})[level] ||= [0, 0]);
  a[0] += r * n;
  a[1] += n;
};
const latestRows = (sheetName) => {
  const rows = readRows(file, sheets[sheetName], strings).filter((r) => r.StudentGroup === 'All Students');
  const latest = rows.map((r) => r.SchoolYear).filter((y) => /^\d{4}-\d{2}$/.test(y || '')).sort().at(-1);
  return rows.filter((r) => r.SchoolYear === latest);
};
for (const [subject, sheet] of [['ELA', 'ELAPerformanceByTest'], ['Math', 'MathPerformancebyTest']]) {
  for (const r of latestRows(sheet)) {
    const code = `${r.CountyCode}-${r.DistrictCode}`;
    for (const [level, tests] of Object.entries(LEVEL_TESTS)) {
      if (tests[subject].includes(r.GradeTest)) add(code, level, rate(r.ProficiencyRate_District), count(r.ValidScores_District));
    }
  }
}
for (const r of latestRows('NJGPA')) {
  const code = `${r.CountyCode}-${r.DistrictCode}`;
  add(code, 'high', rate(r.ELAGraduationReadyPct_District), count(r.ELAValidScores_District));
  add(code, 'high', rate(r.MathGraduationReadyPct_District), count(r.MathValidScores_District));
}
for (const d of districts) {
  for (const level of ['elem', 'mid', 'high']) {
    const a = acc[d.district_code]?.[level];
    d[`${level}_pct`] = a && a[1] ? Math.round((a[0] / a[1]) * 10) / 10 : null;
  }
}
for (const level of ['elem', 'mid', 'high']) rank(districts, `${level}_pct`, `${level}_score`);

// Districts that send middle / high schoolers elsewhere
const byCode = Object.fromEntries(districts.map((d) => [d.district_code, d]));
const sending = {};
const sendFile = join(ROOT, 'data', 'sending.csv');
if (existsSync(sendFile)) {
  const lines = readFileSync(sendFile, 'utf8').trim().split(/\r?\n/).slice(1);
  for (const line of lines) {
    const [code, mid, high] = line.split(',');
    sending[code] = { mid: mid || null, high: high || null };
    for (const c of [mid, high]) if (c && !byCode[c]) console.warn(`sending.csv: unknown district ${c}`);
  }
}
const levelInfo = (d) => {
  const pick = (level, viaCode) => {
    const src = (viaCode && byCode[viaCode]) || d;
    const score = src[`${level}_score`];
    return score == null ? null : { score, pct: src[`${level}_pct`], district: src.district };
  };
  const s = sending[d.district_code] || {};
  return { e: pick('elem'), m: pick('mid', s.mid), h: pick('high', s.high) };
};
const siteSchools = { school_year: ela.latest, districts: {} };
for (const d of districts) siteSchools.districts[`${d.district}|${d.county}`] = levelInfo(d);
writeFileSync(join(ROOT, 'site', 'schools.json'), JSON.stringify(siteSchools));

const esc = (v) => (v == null ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const cols = ['county', 'district_code', 'district', 'school_year', 'ela_pct', 'math_pct', 'score',
  'elem_pct', 'elem_score', 'mid_pct', 'mid_score', 'high_pct', 'high_score'];
const csv = [cols.join(','), ...districts.sort((a, b) => a.county.localeCompare(b.county) || a.district.localeCompare(b.district)).map((d) => cols.map((c) => esc(d[c])).join(','))].join('\n');
writeFileSync(join(ROOT, 'data', 'schools.csv'), csv + '\n');
console.log(`Wrote data/schools.csv: ${districts.length} districts, school year ${ela.latest}`);
const n = (l) => districts.filter((d) => d[`${l}_score`] != null).length;
console.log(`Wrote site/schools.json: ranked ${n('elem')} elementary, ${n('mid')} middle, ${n('high')} high school districts`);
