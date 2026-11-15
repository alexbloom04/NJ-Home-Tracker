# NJ Home Tracker

A free daily dashboard of the housing market in central and northern New Jersey. It shows new listings, available homes, homes under contract (with list price) and sold homes (with sold price and date), broken out by town. You can filter by town, school score, list price, sold price, status, beds, baths, square footage and days on market. Each home has photos and full stats.

- **Listings:** [HomeHarvest](https://github.com/ZacharyHampton/HomeHarvest), a free, open-source library that pulls listing data from Realtor.com. It's unofficial, so if Realtor.com changes its site the fetch can break until the library is updated (`pip install -U homeharvest`).
- **School scores:** NJ Department of Education School Performance Reports (2024-25). Each district gets a 1–10 statewide percentile rank, based on the share of all students who met or exceeded expectations on the NJSLA ELA and Math tests. There are also separate elementary (grades 3–5), middle (ELA 6–8, Math 6–7) and high school (grade 11 NJGPA) ranks. Towns that send students to a regional district get that district's middle or high school rank; those links are listed in `data/sending.csv`.
- **Hosting and daily updates:** GitHub Pages and GitHub Actions, both free.

## How it works

```
GitHub Action (daily 11:00 UTC, about 6am ET)
  scripts/fetch.py   → every for-sale, pending and sold (last 180 days) home in each county
  scripts/build.py   → tracks status changes, builds "what changed", joins school scores
  → saves running state to the `data` branch (one commit, overwritten daily)
  → publishes site/ to GitHub Pages
```

## One-time setup

1. Create a free GitHub account and a new **public** repository (for example `nj-home-tracker`). GitHub Pages is free only for public repos.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/<you>/nj-home-tracker.git
   git push -u origin main
   ```
3. Add the site password: **Settings → Secrets and variables → Actions → New repository secret**. Name it `SITE_PASSWORD` and set the value to a long passphrase. The workflow won't publish anything without it.
4. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
5. Go to **Actions → Update listings → Run workflow**. For a quick first test, enter `Morris` in the county box. Then run it again with the box blank to fetch every county (this takes about 20–60 minutes).
6. Your dashboard is at `https://<you>.github.io/nj-home-tracker/`. After that it updates itself every morning.

## Password protection

All listing data the site serves is gzipped and encrypted with AES-256-GCM. The key is derived from `SITE_PASSWORD` with PBKDF2 (600,000 iterations). The page asks for the password and decrypts in the browser. The saved state on the `data` branch is encrypted the same way. The page code itself is public; the data isn't readable without the password.

- **Strong passphrase:** anyone can download the encrypted files and try passwords offline, so use something long, like four or five random words.
- **"Remember on this device"** keeps the key in that browser. Click **Lock** to forget it.
- **Changing the password:** update the secret, delete the `data` branch (the old encrypted state can't be read with the new password), then run the workflow.

## Customizing

- **Counties, sold lookback, "new" window:** edit `config.yaml`.
- **Town not matched to a school district:** each run's log lists unmatched towns. Add a row to `data/town_aliases.csv` with `town,district_code` (look up codes in `data/schools.csv`).
- **Refresh school scores** when NJ DOE publishes a new year: `node scripts/build_schools.mjs` (set `SPR_YEAR=2025-2026` to choose the year), then commit `data/schools.csv` and `site/schools.json`.
- **Town sends students to a regional middle or high school:** add a row to `data/sending.csv` (`district_code,middle_code,high_code`), then rerun `node scripts/build_schools.mjs`.

## Previewing locally

```bash
node scripts/make_sample.mjs
```
```bash
node scripts/serve.mjs
```
Then open http://localhost:5173. `make_sample.mjs` writes fake data into `site/data`; real runs overwrite it.

## Notes and limits

- "Under contract" covers Realtor.com's pending and contingent statuses. Its date is the listing's pending date when available. Otherwise it's the first day the tracker saw the home as under contract.
- "New" means listed within the last 7 days.
- Town names are Realtor.com's postal city names. For example, "Morristown" can include parts of Morris Township.
- The "What changed" feed and the market trend chart build up day by day from the first run.
- Photos are linked from Realtor.com's image servers, not copied.
