"""Turn today's fetch into the dashboard's JSON files and update running state.

    python scripts/build.py --today state/today.json --state state --out site/data

State (kept between runs, on the `data` branch):
  state.json    per-home first-seen date, status history and list-price history
  events.json   "what changed" log (new / pending / sold / price change / back on market)
  history.json  daily market stats per town, for trend charts
"""

import argparse
import csv
import json
import re
import shutil
import statistics
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
CFG = yaml.safe_load((ROOT / "config.yaml").read_text())


def load(path, default):
    p = Path(path)
    return json.loads(p.read_text()) if p.exists() else default


def dump(path, obj):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(obj, separators=(",", ":")))


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", (s or "unknown").lower()).strip("-") or "unknown"


def median(xs):
    xs = [x for x in xs if x]
    return round(statistics.median(xs)) if xs else None


# ---------------------------------------------------------------- schools

STOP = {"public", "school", "schools", "district", "township", "twp", "borough", "boro", "town",
        "city", "village", "of", "the", "k", "8", "k8", "regional", "high", "board", "education",
        "consolidated", "unified"}


def norm(name):
    words = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower()).split()
    out = " ".join(w for w in words if w not in STOP)
    return re.sub(r"s\b", "", out)  # "chathams" ~ "chatham"


class Schools:
    def __init__(self):
        self.districts = []
        p = ROOT / "data" / "schools.csv"
        if p.exists():
            with p.open(newline="") as f:
                for r in csv.DictReader(f):
                    r["n"] = norm(r["district"])
                    r["hs_only"] = bool(re.search(r"regional high", r["district"], re.I))
                    self.districts.append(r)
        self.by_code = {d["district_code"]: d for d in self.districts}
        self.aliases = {}
        p = ROOT / "data" / "town_aliases.csv"
        if p.exists():
            with p.open(newline="") as f:
                for r in csv.DictReader(f):
                    if r.get("town") and r.get("district_code"):
                        self.aliases[r["town"].strip().lower()] = r["district_code"].strip()
        self.cache = {}

    def match(self, town, county):
        key = (town, county)
        if key in self.cache:
            return self.cache[key]
        best = None
        code = self.aliases.get((town or "").lower())
        if code in self.by_code:
            best = self.by_code[code]
        else:
            t = norm(town)
            ranked = []
            for d in self.districts:
                if not t:
                    break
                if d["n"] == t:
                    kind = 0
                elif re.search(rf"\b{re.escape(t)}\b", d["n"]):
                    kind = 1
                else:
                    continue
                ranked.append((kind, d["county"] != county, d["hs_only"], len(d["n"]), d["district"], d))
            if ranked:
                best = min(ranked, key=lambda x: x[:5])[-1]
        self.cache[key] = best
        return best


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--today", required=True)
    ap.add_argument("--state", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--date", help="override today's date (YYYY-MM-DD)")
    args = ap.parse_args()

    today = date.fromisoformat(args.date) if args.date else date.today()
    t = today.isoformat()
    new_cut = (today - timedelta(days=CFG.get("new_days", 7))).isoformat()
    state_dir = Path(args.state)

    homes = load(args.today, [])
    state = load(state_dir / "state.json", {})
    events = load(state_dir / "events.json", [])
    history = load(state_dir / "history.json", [])
    initial = not state
    schools = Schools()

    events = [e for e in events if e["d"] != t]  # re-running the same day replaces its events

    def event(kind, h, **extra):
        e = {"d": t, "type": kind, "id": h["id"], "addr": h["addr"], "city": h["city"],
             "lp": h["lp"], "img": (h["photos"] or [None])[0]}
        e.update(extra)
        events.append(e)

    seen = set()
    for h in homes:
        hid = h["id"]
        seen.add(hid)
        s = state.get(hid)
        if s is None:
            s = state[hid] = {"fs": t, "fi": int(initial), "st": h["st"], "ss": None if initial else t, "ph": []}
            if initial:
                # Seed the feed from listing/sale dates so day one isn't empty
                if h["st"] == "A" and (h["ld"] or "") >= new_cut:
                    event("new", h, d=h["ld"])
                elif h["st"] == "S" and (h["sd"] or "") >= new_cut:
                    event("sold", h, sp=h["sp"], d=h["sd"])
            elif h["st"] == "A":
                event("new", h)
            elif h["st"] == "P":
                event("pending", h)
            elif h["st"] == "S" and (h["sd"] or "") >= new_cut:
                event("sold", h, sp=h["sp"])
        else:
            prev = s["st"]
            if prev != h["st"]:
                if h["st"] == "P":
                    event("pending", h)
                elif h["st"] == "S":
                    event("sold", h, sp=h["sp"])
                elif h["st"] == "A" and prev == "P":
                    event("back", h)
                s["st"], s["ss"] = h["st"], t
        # List-price history
        if h["lp"]:
            ph = s["ph"]
            if ph and ph[-1][1] != h["lp"] and h["st"] == "A":
                event("price", h, old=ph[-1][1])
            if not ph or ph[-1][1] != h["lp"]:
                ph.append([t, h["lp"]])
        s["ls"] = t

    # Forget homes not seen for 60 days
    stale = (today - timedelta(days=60)).isoformat()
    state = {k: v for k, v in state.items() if k in seen or v.get("ls", t) >= stale}
    keep = (today - timedelta(days=CFG.get("event_days", 30))).isoformat()
    events = sorted((e for e in events if (e["d"] or "") >= keep), key=lambda e: e["d"] or "", reverse=True)

    # ---------------- outputs
    out = Path(args.out)
    if (out / "details").exists():
        shutil.rmtree(out / "details")
    listings, details = [], defaultdict(dict)
    for h in homes:
        s = state[h["id"]]
        d = schools.match(h["city"], h["county"])
        ph = s["ph"]
        drop = (ph[0][1] - h["lp"]) if h["st"] == "A" and len(ph) > 1 and h["lp"] else None
        is_new = h["st"] == "A" and ((h["ld"] or "") >= new_cut or (not s.get("fi") and s["fs"] >= new_cut))
        listings.append({
            "id": h["id"], "st": h["st"], "sub": h["sub"], "addr": h["addr"], "unit": h["unit"],
            "city": h["city"], "zip": h["zip"], "county": h["county"], "lat": h["lat"], "lng": h["lng"],
            "lp": h["lp"], "sp": h["sp"], "sd": h["sd"], "ld": h["ld"],
            "pd": h["pd"] or (s["ss"] if h["st"] == "P" else None),
            "beds": h["beds"], "baths": h["baths"], "sqft": h["sqft"], "lot": h["lot"], "yb": h["yb"],
            "dom": h["dom"], "type": h["type"], "img": (h["photos"] or [None])[0],
            "sc": int(d["score"]) if d and d.get("score") else None,
            "new": int(is_new), "drop": drop if drop and drop > 0 else None, "fs": s["fs"],
        })
        details[slug(h["city"])][h["id"]] = {
            "photos": h["photos"], "desc": h["desc"], "tax": h["tax"], "hoa": h["hoa"], "est": h["est"],
            "assessed": h["assessed"], "stories": h["stories"], "garage": h["garage"],
            "new_build": h["new_build"], "schools_near": h["schools_near"], "url": h["url"], "mls": h["mls"],
            "ph": ph, "district": d["district"] if d else None,
            "ela": d["ela_pct"] if d else None, "math": d["math_pct"] if d else None,
        }

    # Per-town summary
    sold_cut = (today - timedelta(days=30)).isoformat()
    by_town = defaultdict(list)
    for h in listings:
        by_town[(h["city"], h["county"])].append(h)
    towns = []
    for (city, county), hs in sorted(by_town.items()):
        act = [h for h in hs if h["st"] == "A"]
        sold = [h for h in hs if h["st"] == "S"]
        ratios = [h["sp"] / h["lp"] for h in sold if h["sp"] and h["lp"]]
        d = schools.match(city, county)
        towns.append({
            "town": city, "county": county, "slug": slug(city),
            "district": d["district"] if d else None, "sc": int(d["score"]) if d and d.get("score") else None,
            "ela": float(d["ela_pct"]) if d and d.get("ela_pct") else None,
            "math": float(d["math_pct"]) if d and d.get("math_pct") else None,
            "active": len(act), "new": sum(h["new"] for h in hs),
            "pending": sum(h["st"] == "P" for h in hs), "sold": len(sold),
            "sold30": sum((h["sd"] or "") >= sold_cut for h in sold),
            "med_list": median(h["lp"] for h in act), "med_sold": median(h["sp"] for h in sold),
            "med_dom": median(h["dom"] for h in act),
            "stl": round(statistics.mean(ratios) * 100, 1) if ratios else None,
            "ppsf": median(round(h["lp"] / h["sqft"]) for h in act if h["lp"] and h["sqft"]),
        })

    # Daily trend point per town + overall
    history = [r for r in history if r["d"] != t]

    def snap(name, hs):
        sold = [h for h in hs if h["st"] == "S" and (h["sd"] or "") >= sold_cut]
        return {"d": t, "town": name, "active": sum(h["st"] == "A" for h in hs),
                "pending": sum(h["st"] == "P" for h in hs), "sold30": len(sold),
                "med_list": median(h["lp"] for h in hs if h["st"] == "A"),
                "med_sold": median(h["sp"] for h in sold)}

    history.append(snap("All", listings))
    for (city, _), hs in by_town.items():
        history.append(snap(city, hs))

    dump(out / "listings.json", listings)
    for town_slug, rows in details.items():
        dump(out / "details" / f"{town_slug}.json", rows)
    dump(out / "towns.json", towns)
    dump(out / "changes.json", events)
    dump(out / "history.json", history)
    dump(out / "meta.json", {
        "updated": t, "initial": initial, "sample": False, "counties": CFG["counties"],
        "sold_days": CFG.get("sold_days", 180), "new_days": CFG.get("new_days", 7),
        "counts": {k: sum(h["st"] == k for h in listings) for k in "APS"},
        "school_year": schools.districts[0]["school_year"] if schools.districts else None,
    })
    dump(state_dir / "state.json", state)
    dump(state_dir / "events.json", events)
    dump(state_dir / "history.json", history)
    unmatched = sorted({x["town"] for x in towns if not x["district"]})
    print(f"{len(listings)} homes, {len(towns)} towns, {len(events)} events")
    if unmatched:
        print(f"No school district matched for {len(unmatched)} towns (add to data/town_aliases.csv): "
              + ", ".join(unmatched))


if __name__ == "__main__":
    main()
