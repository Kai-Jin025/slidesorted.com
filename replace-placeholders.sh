#!/bin/bash
#
# Replace the deployment placeholders across the whole site.
#
#   Usage:  ./replace-placeholders.sh https://yourdomain.com "YourBrand" [splitAt]
#
# Rewrites:
#   https://example.com          ->  your domain   (canonical, og:url, og:image,
#                                                   JSON-LD, sitemap, robots)
#   Slide<span>Sorted</span>     ->  your brand    (the header logo)
#   "SlideSorted"                ->  your brand    (WebSite schema name, og:site_name)
#
# The brand is escaped for the context it lands in, so names containing
# & < > " work in both HTML and the JSON-LD block.
#
# splitAt is optional: the number of leading characters to leave unaccented,
# which keeps the two-tone logo instead of flattening it. So the current
# lockup is reproduced by asking for the name you already have:
#
#   ./replace-placeholders.sh https://slidesorted.com "SlideSorted" 5
#
# Run it once, from inside this folder, before deploying.

set -euo pipefail

if [ "$#" -lt 2 ] || [ "$#" -gt 3 ]; then
  echo "usage: $0 https://yourdomain.com \"YourBrand\" [splitAt]" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$0")" && pwd)"

python - "$1" "$2" "${3:-}" "$DIR" <<'PY'
import json, sys, pathlib

domain  = sys.argv[1].rstrip("/")
brand   = sys.argv[2]
split   = sys.argv[3]
root    = pathlib.Path(sys.argv[4])

if not domain.startswith(("http://", "https://")):
    sys.exit("domain must start with http:// or https://")

def esc(s):
    return (s.replace("&", "&amp;").replace("<", "&lt;")
             .replace(">", "&gt;").replace('"', "&quot;"))

# HTML contexts need entity escaping; the JSON-LD <script> block does not,
# and needs JSON escaping instead.
json_brand = json.dumps(brand)[1:-1]

two_tone = False
if split:
    try:
        n = int(split)
    except ValueError:
        sys.exit("splitAt must be a whole number of characters")
    if not 0 < n < len(brand):
        sys.exit(f"splitAt must be between 1 and {len(brand) - 1} for {brand!r}")
    html_brand = esc(brand[:n]) + "<span>" + esc(brand[n:]) + "</span>"
    two_tone = True
else:
    html_brand = esc(brand)

html_files  = sorted(root.glob("*.html"))
html_files  = [p for p in html_files if not p.name.startswith("_")]
other_files = [root / "sitemap.xml", root / "robots.txt"]

changed = []

for p in html_files:
    t = p.read_text(encoding="utf-8")
    before = t
    t = t.replace("https://example.com", domain)
    # og:site_name first: the generic brand rule below would otherwise match
    # the quoted value inside this attribute too.
    t = t.replace('content="SlideSorted"', f'content="{esc(brand)}"')
    t = t.replace("Slide<span>Sorted</span>", html_brand)
    t = t.replace('"SlideSorted"', f'"{json_brand}"')
    if t != before:
        p.write_text(t, encoding="utf-8", newline="")
        changed.append(p.name)

for p in other_files:
    if not p.exists():
        continue
    t = p.read_text(encoding="utf-8")
    if "https://example.com" in t:
        p.write_text(t.replace("https://example.com", domain),
                     encoding="utf-8", newline="")
        changed.append(p.name)

print(f"Domain set to: {domain}")
print(f"Brand set to:  {brand}")
print(f"Files rewritten: {len(changed)}")

leftovers = [p.name for p in html_files + other_files
             if p.exists() and "example.com" in p.read_text(encoding="utf-8")]
print()
if leftovers:
    print("WARNING - example.com still present in:")
    for n in leftovers:
        print("  " + n)
else:
    print("OK - no example.com placeholders left.")

print()
if two_tone:
    print(f"Logo kept two-tone: {brand[:int(split)]} + accent {brand[int(split):]}")
else:
    print("Logo flattened to plain text. To keep a two-tone lockup, re-run with")
    print(f'  splitAt, e.g.  $0 {domain} "{brand}" {max(1, len(brand) // 2)}')
PY
