#!/usr/bin/env python3
"""Site QA for the PowerPoint guide site. Run from this folder:

    python check-site.py

Checks every page, diagram and the sitemap together:
  - SVG: canvas overflow, viewBox/width agreement, presence of <title>
  - HTML: tag balance, exactly one H1, title/description/canonical/OG tags
  - JSON-LD parses, and each page carries the expected schema types
  - every HowTo step name is a heading the reader can actually see
  - titles, meta descriptions and canonicals are unique across the site
  - sitemap.xml lists exactly the canonical URLs, nothing more, nothing less
  - every href and <img src> resolves; every image has alt/width/height/loading/decoding
  - no orphaned diagrams and no diagram used by zero pages

Exit code 1 means something is broken; warnings are advisory.
"""
import os, re, json, glob, sys, html
from html.parser import HTMLParser
from urllib.parse import urlparse
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.abspath(__file__))
FAIL = []
WARN = []

# SVGs that are site chrome rather than diagrams. They are referenced through
# <link rel="icon">, not <img>, so the diagram checks must not judge them.
ICON_SVGS = {"favicon.svg"}

def fail(msg): FAIL.append(msg)
def warn(msg): WARN.append(msg)

def norm_ws(s):
    """Collapse whitespace and fold curly quotes, so a schema string matches
    the visible heading it mirrors even if the two use different apostrophes."""
    s = s.replace("’", "'").replace("‘", "'")
    s = s.replace("“", '"').replace("”", '"')
    return re.sub(r"\s+", " ", s).strip()

# ---------------------------------------------------------------- SVG check
SVG_NS = "{http://www.w3.org/2000/svg}"

def css_sizes(style_text):
    """Pull `selector { ... font-size: Npx ... }` into {'.name': px}."""
    out = {}
    for m in re.finditer(r"([^{}]+)\{([^}]*)\}", style_text):
        sel, body = m.group(1).strip(), m.group(2)
        fs = re.search(r"font-size\s*:\s*([\d.]+)px", body)
        ls = re.search(r"letter-spacing\s*:\s*([\d.]+)em", body)
        if fs:
            for part in sel.split(","):
                key = part.strip()
                out.setdefault(key, {})
                out[key]["size"] = float(fs.group(1))
                if ls:
                    out[key]["ls"] = float(ls.group(1))
    return out

# conservative-ish average advance width per em for mixed-case UI text
CHAR_W = 0.50
# bold text runs a little wider
CHAR_W_BOLD = 0.53

def svg_check(path):
    name = os.path.basename(path)
    raw = open(path, encoding="utf-8").read()
    try:
        root = ET.fromstring(raw)
    except ET.ParseError as e:
        fail(f"{name}: XML parse error: {e}")
        return
    vb = root.get("viewBox", "").split()
    if len(vb) != 4:
        fail(f"{name}: missing/short viewBox")
        return
    vw, vh = float(vb[2]), float(vb[3])
    if root.get("width") != vb[2] or root.get("height") != vb[3]:
        fail(f"{name}: width/height ({root.get('width')}x{root.get('height')}) "
             f"!= viewBox ({vb[2]}x{vb[3]})")

    style_text = ""
    for s in root.iter(SVG_NS + "style"):
        style_text += s.text or ""
    sizes = css_sizes(style_text)

    if not any(t.tag == SVG_NS + "title" for t in root):
        fail(f"{name}: no <title>")
    # Icon SVGs are referenced by <link rel="icon">, not <img>, so the diagram
    # rules (720px canvas, text must fit) do not apply to them.
    if name not in ICON_SVGS and root.get("width") and int(root.get("width")) != 720:
        warn(f"{name}: width is {root.get('width')}, pages declare 720")

    checked = 0
    for t in root.iter(SVG_NS + "text"):
        text = "".join(t.itertext()).strip()
        if not text:
            continue
        checked += 1
        cls = (t.get("class") or "").split()
        default_size = 12.0
        ls_em = 0.0
        for c in cls:
            key = "." + c
            if key in sizes:
                default_size = sizes[key]["size"]
                ls_em = sizes[key].get("ls", 0.0)
                break
        fs = float(t.get("font-size", default_size))
        bold = t.get("font-weight") == "700" or "font-weight: 700" in (t.get("style") or "")
        cw = CHAR_W_BOLD if bold else CHAR_W
        # letter-spacing applies on top of the glyph advance
        width = len(text) * (fs * (cw + ls_em))
        x = float(t.get("x", 0))
        anchor = t.get("text-anchor", "start")
        if anchor == "middle":
            right = x + width / 2
            left = x - width / 2
        elif anchor == "end":
            right = x
            left = x - width
        else:
            right = x + width
            left = x
        y = float(t.get("y", 0))
        if right > vw + 0.5:
            fail(f"{name}: text past right edge (ends ~{right:.0f} vs {vw:.0f}): {text[:52]!r}")
        elif right > vw - 12:
            warn(f"{name}: text near right edge (ends ~{right:.0f}/{vw:.0f}): {text[:52]!r}")
        if left < -0.5:
            fail(f"{name}: text past left edge (starts ~{left:.0f}): {text[:52]!r}")
        # descender: baseline + ~0.22em
        if y + fs * 0.22 > vh + 0.5:
            fail(f"{name}: text past bottom ({y + fs * 0.22:.0f} vs {vh:.0f}): {text[:40]!r}")
        # ascender top sits ~0.85em above the baseline
        if y - fs * 0.85 < -0.5:
            fail(f"{name}: text above top (ascender ~{y - fs * 0.85:.0f}): {text[:40]!r}")
    return checked

# ---------------------------------------------------------------- HTML check
VOID = {"area","base","br","col","embed","hr","img","input","link","meta",
        "param","source","track","wbr"}

class Balance(HTMLParser):
    def __init__(self, name):
        super().__init__(convert_charrefs=True)
        self.name, self.stack, self.bad = name, [], []
    def handle_starttag(self, tag, attrs):
        if tag in VOID:
            return
        self.stack.append((tag, self.getpos()[0]))
    def handle_startendtag(self, tag, attrs): pass
    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack:
            self.bad.append(f"stray </{tag}> at line {self.getpos()[0]}")
            return
        if self.stack[-1][0] != tag:
            close = None
            for i in range(len(self.stack) - 1, -1, -1):
                if self.stack[i][0] == tag:
                    close = i
                    break
            if close is None:
                self.bad.append(f"</{tag}> never opened (line {self.getpos()[0]})")
                return
            unclosed = ", ".join(f"<{t}>@{l}" for t, l in self.stack[close + 1:])
            self.bad.append(f"</{tag}> at line {self.getpos()[0]} but {unclosed} still open")
            del self.stack[close:]
            return
        self.stack.pop()

def html_check(path, all_pages):
    name = os.path.basename(path)
    raw = open(path, encoding="utf-8").read()
    # normalize CRLF for the dangling-<br> style checks
    text = raw

    b = Balance(name)
    b.feed(raw)
    for m in b.bad:
        fail(f"{name}: {m}")
    if b.stack:
        fail(f"{name}: unclosed at EOF: " +
             ", ".join(f"<{t}>@{l}" for t, l in b.stack))

    # --- structural SEO requirements
    for tag, pat, label in [
        ("h1", r"<h1[^>]*>", "exactly one H1"),
    ]:
        n = len(re.findall(pat, text, re.I))
        if n != 1:
            fail(f"{name}: {n} H1 tags (need 1)")

    title = re.search(r"<title>(.*?)</title>", text, re.S)
    if not title:
        fail(f"{name}: no <title>")
    desc = re.search(r'<meta name="description" content="(.*?)"', text, re.S)
    if not desc:
        fail(f"{name}: no meta description")
    canon = re.search(r'<link rel="canonical" href="(.*?)"', text)
    if not canon:
        fail(f"{name}: no canonical")

    og = len(re.findall(r'<meta property="og:', text))
    if og < 4:
        fail(f"{name}: only {og} Open Graph tags")

    # --- stylesheet + no leftovers
    if 'href="styles.css"' not in text:
        fail(f"{name}: does not link styles.css")
    for bad in ["<em>", "TODO", "FIXME", "lorem ipsum"]:
        if bad.lower() in text.lower() and bad != "<em>":
            warn(f"{name}: contains {bad!r}")
    if re.search(r"</em>", text) and "<em>" not in text:
        fail(f"{name}: dangling </em>")

    # --- JSON-LD
    body = text.split("</head>", 1)[-1]
    blocks = re.findall(r'<script type="application/ld\+json">(.*?)</script>', text, re.S)
    if not blocks:
        fail(f"{name}: no JSON-LD")
    types_seen = []
    for i, blk in enumerate(blocks):
        try:
            data = json.loads(blk)
        except json.JSONDecodeError as e:
            fail(f"{name}: JSON-LD block {i} invalid: {e}")
            continue
        for node in data.get("@graph", [data]):
            types_seen.append(node.get("@type"))

            # A HowTo is only honoured if its step names are the headings the
            # reader actually sees. Google matches them; if they drift the
            # markup is ignored, silently. Compare them literally.
            if node.get("@type") == "HowTo":
                visible = {
                    norm_ws(html.unescape(re.sub(r"<[^>]+>", "", h)))
                    for h in re.findall(r"<h[1-6][^>]*>(.*?)</h[1-6]>", body, re.S)
                }
                for step in node.get("step", []):
                    sn = norm_ws(step.get("name", ""))
                    if sn and sn not in visible:
                        fail(f"{name}: HowTo step {sn!r} is not a heading on the page")
    return name, types_seen, canon.group(1) if canon else None

# ---------------------------------------------------------------- run
os.chdir(ROOT)
svgs = sorted(glob.glob("images/*.svg"))
print(f"=== SVG ({len(svgs)}) ===")
total_texts = 0
for s in svgs:
    n = svg_check(s)
    total_texts += n or 0
    print(f"  {os.path.basename(s):38s} {os.path.getsize(s):>6d} B  {n} text nodes")

pages = sorted(glob.glob("*.html"))
print(f"\n=== HTML ({len(pages)}) ===")
meta = {}
all_canon = []
for p in pages:
    name, types, canon = html_check(p, pages)
    meta[name] = (types, canon)
    all_canon.append(canon)
    print(f"  {name:52s} {os.path.getsize(p):>6d} B  {types}")

# --- unique titles / descriptions / canonicals
titles = {}
descs = {}
for p in pages:
    t = open(p, encoding="utf-8").read()
    ti = re.search(r"<title>(.*?)</title>", t, re.S).group(1).strip()
    de = re.search(r'<meta name="description" content="(.*?)"', t, re.S).group(1).strip()
    titles.setdefault(ti, []).append(p)
    descs.setdefault(de, []).append(p)
for ti, ps in titles.items():
    if len(ps) > 1:
        fail(f"duplicate <title> across {ps}: {ti[:60]}")
for de, ps in descs.items():
    if len(ps) > 1:
        fail(f"duplicate meta description across {ps}")
if len(all_canon) != len(set(all_canon)):
    fail("duplicate canonical URLs")

# --- sitemap vs canonical
sm = open("sitemap.xml", encoding="utf-8").read()
locs = re.findall(r"<loc>(.*?)</loc>", sm)
def norm(u):
    return u if u.endswith("/") else u + "/"
canon_norm = {norm(c) for c in all_canon if c}
locs_norm = {norm(l) for l in locs}
if canon_norm != locs_norm:
    for u in sorted(canon_norm - locs_norm):
        fail(f"canonical not in sitemap: {u}")
    for u in sorted(locs_norm - canon_norm):
        fail(f"sitemap URL has no matching canonical: {u}")
try:
    ET.fromstring(sm)
except ET.ParseError as e:
    fail(f"sitemap.xml: XML parse error: {e}")

# --- links + images resolve
# Internal links point at the clean paths Cloudflare Pages serves: a flat
# foo.html is reachable at /foo, and the .html form redirects to it. Linking
# straight at the served URL keeps every internal click free of a redirect,
# so the checker has to map those paths back to files on disk.
def clean_path(page):
    return "/" if page == "index.html" else "/" + page[:-5]


def resolve_href(href):
    """The file on disk that serves this link target."""
    if not href.startswith("/"):
        return href
    rel = href.lstrip("/")
    if not rel:
        return "index.html"
    for candidate in (rel + ".html", rel, os.path.join(rel, "index.html")):
        if os.path.exists(candidate):
            return candidate
    return rel + ".html"


print("\n=== references ===")
img_refs, icon_refs, page_refs = {}, {}, {}
for p in pages:
    t = open(p, encoding="utf-8").read()
    for m in re.findall(r'<img[^>]*src="([^"]+)"', t):
        img_refs.setdefault(os.path.normpath(m), []).append(p)
        if not os.path.exists(m):
            fail(f"{p}: missing image {m}")
        # every <img> needs alt / width / height / loading / decoding
        tag = re.search(r'<img[^>]*src="' + re.escape(m) + r'"[^>]*>', t).group(0)
        for attr in ["alt=", "width=", "height=", "loading=", "decoding="]:
            if attr not in tag:
                fail(f"{p}: <img src={m}> missing {attr}")
    # Icons arrive via <link>, not <img>. Kept in their own dict because the
    # diagram accounting below is about images/ *.svg, and one of these is a PNG.
    for m in re.findall(r'<link[^>]*rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"', t):
        icon_refs.setdefault(os.path.normpath(m), []).append(p)
        if not os.path.exists(m):
            fail(f"{p}: missing icon {m}")

    # og:image is only ever seen by other people, so a broken one is invisible
    # here until somebody shares a link. Point it at a real file.
    m = re.search(r'<meta property="og:image" content="([^"]+)"', t)
    if not m:
        fail(f"{p}: no og:image")
    else:
        # Works on the placeholder domain and on the deployed copy alike.
        rel = urlparse(m.group(1)).path.lstrip("/")
        if rel and not os.path.exists(rel):
            fail(f"{p}: og:image points at a missing file: {rel}")

    for href in re.findall(r'href="([^"#][^"]*)"', t):
        if href.startswith(("http", "mailto:", "//")):
            continue
        if href == "styles.css":
            continue
        page_refs.setdefault(os.path.normpath(resolve_href(href)), []).append(p)
        if not os.path.exists(resolve_href(href)):
            fail(f"{p}: dead link {href}")

on_disk = {os.path.normpath(f) for f in glob.glob("images/*.svg")}
# The favicon is an SVG too, but referenced by <link> rather than <img>.
used_svgs = {k for k in list(img_refs) + list(icon_refs) if k.endswith(".svg")}
unused = sorted(on_disk - used_svgs)
if unused:
    fail(f"unused SVG files: {unused}")
missing = sorted(used_svgs - on_disk)
if missing:
    fail(f"referenced but absent: {missing}")

# every page reachable from every other page (footer grid)
for p in pages:
    t = open(p, encoding="utf-8").read()
    for q in pages:
        if q == p:
            continue
        if f'href="{clean_path(q)}"' not in t:
            warn(f"{p}: does not link to {q}")

# --- trust and sourcing requirements
# Outbound citations to the vendor's own documentation. A page that cites nothing
# gives a reader no way to check it.
AUTH_HOSTS = ("support.microsoft.com", "learn.microsoft.com",
              "support.office.com", "microsoft.com")
for p in pages:
    t = open(p, encoding="utf-8").read()

    # Editorial placeholders must be filled in before this ships. On a live page a
    # visitor would read them.
    for m in sorted(set(re.findall(r"\[\[[^\]]+\]\]", t))):
        fail(f"{p}: unresolved placeholder {m}")

    if p != "about.html":
        if 'href="/about"' not in t:
            fail(f"{p}: no link to /about (author/expertise signal)")
        ext = re.findall(r'href="(https?://[^"]+)"', t)
        if not [u for u in ext if any(h in u for h in AUTH_HOSTS)]:
            fail(f"{p}: no authoritative outbound citation")

# --- the tool script and the tool page must agree on element ids
# A renamed id in the HTML is a silent breakage: the script finds null and the
# report never draws. Cheaper to catch here than in a visitor's browser.
TOOL_PAGE = "powerpoint-file-size-checker.html"
if os.path.exists(TOOL_PAGE) and os.path.exists("pptx-inspector.js"):
    js = open("pptx-inspector.js", encoding="utf-8").read()
    present = set(re.findall(r'\sid="([^"]+)"', open(TOOL_PAGE, encoding="utf-8").read()))
    wanted = set(re.findall(r"""\$\(['"]([a-z0-9_-]+)['"]\)""", js))
    for missing in sorted(wanted - present):
        near = sorted(i for i in present if i[:4] == missing[:4])
        fail(f"{TOOL_PAGE}: the script looks for id=\"{missing}\" which the page "
             f"does not define" + (f" (did you mean {', '.join(near)}?)" if near else ""))
    # Ids the page itself refers to (aria-labelledby, for=, in-page anchors) are
    # legitimately untouched by the script.
    page_html = open(TOOL_PAGE, encoding="utf-8").read()
    referenced = set(re.findall(r'(?:aria-labelledby|aria-describedby|for)="([^"]+)"', page_html))
    referenced |= set(re.findall(r'href="#([^"]+)"', page_html))
    for unused in sorted(present - wanted - referenced):
        warn(f"{TOOL_PAGE}: id=\"{unused}\" is defined but never used by the script")

# --- brand / domain placeholder coverage
brand_files = [p for p in pages if "Slide<span>Sorted</span>" in open(p, encoding="utf-8").read()]
print(f"\n=== placeholders ===")
print(f"  brand markup 'Slide<span>Sorted</span>' in {len(brand_files)}/{len(pages)} pages")
print(f"  'https://example.com' occurrences: "
      f"{sum(open(p, encoding='utf-8').read().count('https://example.com') for p in pages + ['sitemap.xml', 'robots.txt'])}")

# ------------------------------------------- optional: verify outbound citations
# Off by default so the script stays offline and instant. Run it before a release:
# citations to vendor documentation are the site's sourcing, and dead ones are worse
# than none.
if "--check-links" in sys.argv:
    import urllib.request, urllib.error
    urls = set()
    for p in pages:
        for u in re.findall(r'href="(https?://[^"]+)"', open(p, encoding="utf-8").read()):
            if "example.com" not in u:
                urls.add(u)
    print(f"\n=== external links ({len(urls)}) ===")
    for u in sorted(urls):
        try:
            req = urllib.request.Request(
                u, method="HEAD", headers={"User-Agent": "Mozilla/5.0"})
            with urllib.request.urlopen(req, timeout=25) as r:
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code
        except Exception as e:
            code = type(e).__name__
        ok = code == 200
        print(f"  {'ok  ' if ok else 'FAIL'} {code}  {u}")
        if not ok:
            warn(f"citation did not return 200: {u} ({code})")

# ---------------------------------------------------------------- report
print("\n" + "=" * 62)
if FAIL:
    print(f"FAIL — {len(FAIL)} error(s):")
    for f in FAIL:
        print("  ✗ " + f)
else:
    print("PASS — no errors")
if WARN:
    print(f"\n{len(WARN)} warning(s):")
    for w in WARN:
        print("  · " + w)
print("=" * 62)
sys.exit(1 if FAIL else 0)
