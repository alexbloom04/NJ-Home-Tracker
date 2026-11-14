"""Pull every for-sale, pending/contingent and recently-sold home for each configured county.

Uses HomeHarvest (Realtor.com). Writes one normalized JSON list to the output path.

    python scripts/fetch.py --out state/today.json [--prev state/prev.json] [--county Morris]

If a county/listing-type query fails after retries, the matching homes from --prev are
carried forward so a temporary outage doesn't look like every home disappeared.
"""

import argparse
import json
import math
import sys
import time
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd
import yaml
from homeharvest import scrape_property

ROOT = Path(__file__).resolve().parent.parent
CFG = yaml.safe_load((ROOT / "config.yaml").read_text())

LISTING_TYPES = ["for_sale", "pending", "sold"]
# Later types win when the same property shows up twice (a sale beats a stale active row)
TYPE_RANK = {"for_sale": 0, "pending": 1, "sold": 2}
RESULT_CAP = 10000       # Realtor.com/HomeHarvest max results per query
SOLD_WINDOW_DAYS = 30    # sold homes are fetched in date windows to stay under the cap


def val(v):
    """Convert pandas/numpy/datetime values to plain JSON-safe Python."""
    if v is None or isinstance(v, (list, dict, tuple)):
        return v
    if isinstance(v, float) and math.isnan(v):
        return None
    try:
        if pd.isna(v):
            return None
    except (TypeError, ValueError):
        pass
    if isinstance(v, (pd.Timestamp, datetime, date)):
        return v.strftime("%Y-%m-%d")
    if hasattr(v, "value") and not isinstance(v, (str, int, float)):  # Enum
        return v.value
    if hasattr(v, "item"):  # numpy scalar
        return v.item()
    if isinstance(v, str) and len(v) >= 19 and v[4] == "-" and v[10] in "T ":
        return v[:10]  # ISO timestamp -> date
    return v


def num(v):
    v = val(v)
    if v is None or v == "" or isinstance(v, (list, dict)):
        return None
    try:
        f = float(v)
        return int(f) if f.is_integer() else round(f, 2)
    except (TypeError, ValueError):
        return None


def flatten(obj, out=None):
    """Flatten nested dicts (pydantic model_dump / raw json) so fields can be looked up by name.

    Top-level names win; nested names are added when not already present, and also as parent_child.
    """
    out = {} if out is None else out
    nested = []
    for k, v in obj.items():
        if isinstance(v, dict):
            nested.append((k, v))
        elif k not in out:
            out[k] = v
    for parent, d in nested:
        sub = flatten(d)
        for k, v in sub.items():
            out.setdefault(k, v)
            out.setdefault(f"{parent}_{k}", v)
    return out


def first(row, *names):
    for n in names:
        v = val(row.get(n))
        if v not in (None, "", [], {}):
            return v
    return None


def photo_url(p):
    if isinstance(p, dict):
        p = p.get("href") or p.get("url")
    p = str(p or "").strip()
    return p if p.startswith("http") else None


def photo_list(row, limit):
    candidates = [row.get("primary_photo")]
    for key in ("photos", "alt_photos"):
        v = row.get(key)
        if isinstance(v, (list, tuple)):
            candidates += list(v)
        elif isinstance(v, str):
            candidates += v.split(",")
    photos = []
    for p in candidates:
        u = photo_url(p)
        if u and u not in photos:
            photos.append(u)
    return photos[:limit]


def status_of(listing_type, raw_status, mls_status):
    s = f"{raw_status or ''} {mls_status or ''}".upper()
    if listing_type == "sold" or "SOLD" in s:
        return "S"
    if listing_type == "pending" or any(k in s for k in ("PENDING", "CONTINGENT", "UNDER CONTRACT")):
        return "P"
    return "A"


def schools_text(v):
    if isinstance(v, (list, tuple)):
        names = [x.get("name") if isinstance(x, dict) else str(x) for x in v]
        return ", ".join(n for n in names if n) or None
    return val(v)


def normalize(row, listing_type, county):
    pid = first(row, "property_id", "listing_id", "property_url")
    if not pid:
        return None
    full = num(first(row, "full_baths", "baths_full")) or 0
    half = num(first(row, "half_baths", "baths_half")) or 0
    st = status_of(listing_type, first(row, "status"), first(row, "mls_status"))
    return {
        "id": str(pid),
        "st": st,
        "sub": first(row, "mls_status", "status"),
        "addr": first(row, "street", "address_street", "line", "formatted_address"),
        "unit": first(row, "unit"),
        "city": str(first(row, "city") or "").strip().title(),
        "zip": first(row, "zip_code", "postal_code", "zip"),
        "county": county,
        "lat": num(first(row, "latitude", "lat")),
        "lng": num(first(row, "longitude", "lon", "lng")),
        "lp": num(first(row, "list_price")),
        "sp": num(first(row, "sold_price", "last_sold_price")) if st == "S" else None,
        "sd": first(row, "last_sold_date", "sold_date") if st == "S" else None,
        "ld": first(row, "list_date"),
        "pd": first(row, "pending_date"),
        "beds": num(first(row, "beds")),
        "baths": (full + 0.5 * half) or num(first(row, "baths")),
        "sqft": num(first(row, "sqft")),
        "lot": num(first(row, "lot_sqft")),
        "yb": num(first(row, "year_built")),
        "dom": num(first(row, "days_on_mls")),
        "type": first(row, "style", "type"),
        "url": first(row, "property_url"),
        "mls": first(row, "mls_id"),
        "photos": photo_list(row, CFG.get("max_photos", 15)),
        "desc": first(row, "text"),
        "tax": num(first(row, "tax", "tax_amount")),
        "hoa": num(first(row, "hoa_fee")),
        "est": num(first(row, "estimated_value")),
        "assessed": num(first(row, "tax_assessed_value", "assessed_value")),
        "stories": num(first(row, "stories")),
        "garage": num(first(row, "garage", "parking_garage")),
        "new_build": bool(first(row, "new_construction")),
        "schools_near": schools_text(row.get("nearby_schools")),
        "_t": listing_type,
    }


def to_rows(result):
    """HomeHarvest returns pydantic models, dicts or a DataFrame depending on return_type."""
    if result is None:
        return []
    if isinstance(result, pd.DataFrame):
        return [flatten(r) for r in result.to_dict("records")]
    rows = []
    for r in result:
        if hasattr(r, "model_dump"):
            r = r.model_dump(mode="json")
        rows.append(flatten(r))
    return rows


def scrape_once(tries=3, **kwargs):
    for attempt in range(1, tries + 1):
        try:
            try:
                return to_rows(scrape_property(return_type="pydantic", **kwargs))
            except (TypeError, ValueError) as e:
                if "return_type" not in str(e):
                    raise
                return to_rows(scrape_property(**kwargs))  # older versions: pandas only
        except Exception as e:  # network / blocked / parse errors
            print(f"  ! {kwargs.get('location')} {kwargs.get('listing_type')} attempt {attempt}: {e}", file=sys.stderr)
            time.sleep(15 * attempt)
    return None


def scrape(location, listing_type):
    base = {"location": location, "listing_type": listing_type, "limit": RESULT_CAP}
    if listing_type == "for_sale":
        base["exclude_pending"] = True
    if listing_type != "sold":
        rows = scrape_once(**base)
        if rows is not None and len(rows) >= RESULT_CAP:
            print(f"  ! {location} {listing_type} hit the {RESULT_CAP} result cap; some homes may be missing")
        return rows
    # Sold: walk back in date windows so no single query hits the cap
    end = date.today()
    start_all = end - timedelta(days=CFG.get("sold_days", 180))
    rows = []
    while end > start_all:
        start = max(start_all, end - timedelta(days=SOLD_WINDOW_DAYS))
        chunk = scrape_once(date_from=start.isoformat(), date_to=end.isoformat(), **base)
        if chunk is None:
            return None
        rows += chunk
        end = start - timedelta(days=1)
        time.sleep(2)
    return rows


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--prev", help="previous fetch output, used to fill failed queries")
    ap.add_argument("--county", action="append", help="limit to these counties (testing)")
    args = ap.parse_args()

    prev = []
    if args.prev and Path(args.prev).exists():
        prev = json.loads(Path(args.prev).read_text())

    counties = args.county or CFG["counties"]
    homes, failures, shown_fields = {}, [], False
    for county in counties:
        location = f"{county} County, {CFG.get('state', 'NJ')}"
        for lt in LISTING_TYPES:
            t0 = time.time()
            raw = scrape(location, lt)
            if raw is None:
                failures.append(f"{county}/{lt}")
                rows = [h for h in prev if h.get("county") == county and h.get("_t") == lt]
                print(f"  {location} {lt}: FAILED, carried forward {len(rows)}")
            else:
                if raw and not shown_fields:
                    print("  Fields available:", ", ".join(sorted(raw[0].keys())))
                    shown_fields = True
                rows = [r for r in (normalize(x, lt, county) for x in raw) if r]
                with_photos = sum(bool(r["photos"]) for r in rows)
                print(f"  {location} {lt}: {len(rows)} homes, {with_photos} with photos ({time.time() - t0:.0f}s)")
            for r in rows:
                old = homes.get(r["id"])
                if not old or TYPE_RANK[r["_t"]] >= TYPE_RANK[old["_t"]]:
                    homes[r["id"]] = r
            time.sleep(3)  # be polite between queries

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(list(homes.values()), separators=(",", ":"), default=str))
    print(f"Wrote {len(homes)} homes to {out}")
    if failures:
        print("Failed queries (carried forward): " + ", ".join(failures))
        if len(failures) == len(counties) * len(LISTING_TYPES):
            sys.exit("Every query failed. Realtor.com may be blocking requests.")


if __name__ == "__main__":
    main()
