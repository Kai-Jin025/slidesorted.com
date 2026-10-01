# PowerPoint Guide Site

A static twelve-page site: a hub guide, nine long-tail guides, a trust page, and one
browser-based tool. No build step, no dependencies — upload the folder as-is.

Preview it over a local server rather than by double-clicking the files. Internal links are
absolute paths and only resolve when the site is served from its own root:

```bash
python -m http.server 8000     # then open http://localhost:8000/
```

## URLs

Every internal link is an absolute clean path — `/about`, `/how-to-compress-a-powerpoint-file`
— never `about.html`. That is deliberate, and it is not cosmetic.

Cloudflare Pages serves a flat `about.html` at `/about`, and **redirects** both `/about.html`
and `/about/` to it. The extension stripping cannot be switched off, and `_redirects` cannot
suppress it, because the automatic redirect happens before `_redirects` is consulted. So:

- Internal links point at the URL that returns 200, so no click costs a redirect hop.
- Each page's `canonical` and `og:url` name that same URL. A canonical pointing at a redirect
  is a self-inflicted "Page with redirect" in Search Console.
- The hub is `index.html`, served at `/`.
- `_redirects` retires the pre-launch `/powerpoint-guide.html` path.

To add a page: name the file `<slug>.html`, link to it as `/<slug>`, and set its canonical to
`https://<domain>/<slug>` — no trailing slash. Add it to `sitemap.xml`, then run
`python check-site.py`, which maps clean paths back to files and fails on a typo.

## Before you deploy

The brand is set to **SlideSorted** and the domain still points at `https://example.com`.
Register the domain, then run this once from inside the folder:

```bash
./replace-placeholders.sh https://slidesorted.com "SlideSorted" 5
```

The `5` says "leave the first five characters unaccented", which reproduces the current
two-tone logo — `Slide` in ink, `Sorted` in the accent colour. Drop it and the logo becomes
plain text. Any `splitAt` between 1 and the length of the name works, so a rebrand keeps the
lockup:

```bash
./replace-placeholders.sh https://yourdomain.com "YourBrand" 4
```

The script rewrites the domain in the canonical tags, `og:url`, `og:image`, the JSON-LD,
`sitemap.xml` and `robots.txt`, and swaps the brand in the logo, `og:site_name` and the
`WebSite` schema. It escapes brand names containing `&`, `<`, `>` or quotes for whichever
context they land in, and validates `splitAt` rather than emitting broken markup.

**The name is not trademark-checked.** The domain was free, which is not the same thing.
Check the name is clear in your jurisdiction before you put money behind it.

**`about.html` is already filled in.** It names the author, explains how the guides are
researched, and gives a corrections address. If you change any of those details, edit the
page — it is the site's answer to the "who wrote this, and why should I trust them" question
that search quality guidelines ask, and the other eleven pages are weaker without it.

**Do not upload `tests/fixtures/`.** It is ~20 MB of generated archives. `tests/` as a whole
is development-only; the deployed site is the `.html` files, `styles.css`, `pptx-inspector.js`,
`images/`, `sitemap.xml`, `robots.txt` and `_redirects`.

## Social card and favicon

Three icons and a preview image, all wired into the twelve pages:

| Asset | Used for |
| --- | --- |
| `images/favicon.svg` | Browser tabs. Reads down to 16px |
| `images/apple-touch-icon.png` | 180×180, iOS home screen. Full-bleed square — iOS rounds it |
| `images/social-card.png` | 1200×630 `og:image`. What every shared link shows |
| `images/*.svg` | The ten hand-drawn diagrams |

`check-site.py` fails if any of them is referenced but missing. A broken `og:image` is
invisible from this machine, so it is worth failing the build over.

**The PNGs are generated, not drawn.** Edit the HTML source in `tests/` and re-render with
headless Chrome, which gives exact dimensions without any image tooling installed:

```bash
chrome --headless=new --disable-gpu --hide-scrollbars \
       --force-device-scale-factor=1 --window-size=1200,630 \
       --screenshot=images/social-card.png tests/social-card.html

chrome --headless=new --disable-gpu --hide-scrollbars \
       --force-device-scale-factor=1 --window-size=180,180 \
       --screenshot=images/apple-touch-icon.png tests/apple-touch-icon.html
```

Two notes if you rebrand: the PNGs carry the name, so they need re-rendering, and the
`og:image:alt` text is deliberately brand-free so the deploy script does not have to touch it.

The diagrams are SVG, and social platforms, Slack and most chat clients will not render SVG
previews — which is exactly why the card is a PNG.

## Before you publish: walk the guides once

`about.html` currently claims that **menu paths are checked against Microsoft's own
documentation** — which is true, and is what the citations at the foot of each guide are for.

There is a stronger claim available: that every path has been opened in a real copy of
PowerPoint. Nothing on the site says that today, because it was not done. If you have
PowerPoint installed, doing it upgrades the About page from a sourcing claim to a
first-hand one, and it is the single highest-value hour you can spend on this site.

Open a blank deck and step through each guide with it on screen. Specifically confirm:

- Every `Menu → Item` path lands where the guide says it does
- The two platform notes are right — **Compress Media is Windows-only**, and Mac's new-slide
  shortcut is `⌘⇧N`, not `⌘M`
- Nothing describes a dialog or option that your version does not have

Fix what is wrong, then change that page's `<time datetime="…">` and the visible date. The
About page's "dates change when the content changes" promise only means something if you do.

## The file size checker

`powerpoint-file-size-checker.html` is a working tool, not a demo. Drop a `.pptx` on it and it
lists every image, audio and video file inside, largest first, with each one's share of the
total — plus a verdict naming the likely cause and the matching fix.

It works by reading the ZIP central directory, which records the size of every member. Nothing
is decompressed, so it is instant even on a large deck. **The file never leaves the browser** —
there is no upload step and no server component. That is a real differentiator against the
other tools ranking for this query, and the page says so in a way a reader can verify
(disconnect from the network and it still works).

Implementation lives in `pptx-inspector.js`. Two constraints worth preserving if you edit it:

- **Never assign `innerHTML`.** Filenames come out of a file the user chose, including the
  names archive members carry. Everything goes in through `textContent`. `tests/test-render.js`
  asserts this.
- **Never add a network call.** The privacy claim is the page's whole pitch.

## Running the checks

```bash
python check-site.py                 # offline, instant
python check-site.py --check-links   # also fetches every outbound citation
```

Validates the pages and the diagrams together: SVG canvas overflow, tag balance, one H1 per
page, unique titles/descriptions/canonicals, valid JSON-LD, every `HowTo` step name present
as a visible heading, sitemap ↔ canonical agreement,
that every link and image reference resolves, that each page carries an authoritative
citation and links to `about.html`, that no `[[placeholder]]` is left unfilled, and that
`pptx-inspector.js` and the tool page agree on element ids. Exit code 1 means something is
broken. Run it after any content edit.

`--check-links` adds a network pass over the Microsoft citations. Use it before a release —
those links are the site's sourcing, and when Microsoft reorganises its support site they
break silently.

### The tool's test suite

Needs Node. Generate the fixtures once, then:

```bash
python tests/make-fixtures.py     # builds the archives (~20 MB, gitignored)
node tests/test-inspector.js      # 184 checks: ZIP parsing, classification, totals
node tests/test-render.js         # 30 checks: the report actually draws
```

`test-inspector.js` compares the browser reader against Python's `zipfile` on the same
archives, so a wrong byte offset shows up as a size mismatch rather than as a subtly wrong
number in someone's browser. It covers the ZIP64 path with a 70,000-entry archive, which is
otherwise unreachable for a realistic `.pptx`.

Both suites are mutation-tested: shifting one field offset in the parser produces 48 failures,
and renaming one element id in the page makes `test-render.js` exit 1 with the id it expected
and the nearest match. If you change the parser or the page markup, they will notice.

## Sources on every page

Each guide ends with an **Official references** block citing the Microsoft Support article
covering that task. Two reasons this is there rather than nice-to-have:

- A reader who wants to check a claim has somewhere to go
- It forces the guide to agree with the vendor's own documentation. If you edit a step and
  cannot find it in the cited article, one of the two is wrong

If you change what a guide claims, check whether the citation still supports it.

## What is in here

| File | Purpose |
| --- | --- |
| `index.html` | Hub, served at `/`. "How to Use PowerPoint: The Complete Beginner's Guide" — 8 steps, common mistakes, tutorial path, FAQ |
| `about.html` | Who writes these guides and how they are checked |
| `powerpoint-file-size-checker.html` | The tool. Drag a `.pptx`, see what is inside it |
| `how-to-add-speaker-notes-in-powerpoint.html` | Long-tail |
| `how-to-insert-a-video-in-powerpoint.html` | Long-tail |
| `how-to-add-animation-in-powerpoint.html` | Long-tail |
| `how-to-add-transitions-in-powerpoint.html` | Long-tail. Morph, plus the slide-ownership trap |
| `how-to-use-slide-master-in-powerpoint.html` | Long-tail |
| `how-to-embed-an-excel-chart-in-powerpoint.html` | Long-tail |
| `how-to-make-a-powerpoint-template.html` | Long-tail |
| `how-to-compress-a-powerpoint-file.html` | Troubleshooting |
| `how-to-recover-an-unsaved-powerpoint.html` | Troubleshooting |
| `styles.css` | Shared stylesheet, light and dark |
| `pptx-inspector.js` | The tool's ZIP reader and report renderer |
| `images/*.svg` | Ten hand-drawn diagrams, plus `favicon.svg` |
| `images/social-card.png` | 1200×630 link preview. Generated — see above |
| `sitemap.xml`, `robots.txt` | Submit the sitemap to Google Search Console after deploying |
| `_redirects` | Retires the pre-launch `/powerpoint-guide.html` path. Cloudflare Pages reads it at deploy time |
| `replace-placeholders.sh` | One-shot deployment renaming |
| `check-site.py` | QA script |
| `tests/` | Test suites for the tool, and the social card source. Development only — do not deploy |

## How the pages are structured

Every guide follows the same skeleton, which is what makes the internal linking work:

- `<nav class="crumbs">` breadcrumb back to the hub, mirrored in a `BreadcrumbList` schema
- A `.answer` box directly under the H1 holding the short answer, so it can win the featured
  snippet without the reader scrolling
- `<ol class="steps">` for the procedure, mirrored in a `HowTo` schema with the same order
- An FAQ `<dl>` mirrored in an `FAQPage` schema
- A "Related guides" grid and a full footer grid — every page links to every other page

Heading text inside the `HowTo` schema matches the visible headings word for word. If you
rewrite a step, rewrite it in both places or Google may ignore the markup. **`check-site.py`
now enforces this** — it fails if any `HowTo` step name is not a heading on the page. That
check was added late and immediately found 30 drifted steps across nine pages, two of which
had a schema describing a procedure the page no longer had. Keep them in step.

The tool page is the exception: it carries `WebApplication` instead of `HowTo`, and its answer
box sits above the tool rather than below it, so the explanation is visible before anyone has
to interact with anything.

## Editing notes

- **Adding a page:** copy the closest existing page, change the title, meta description and
  canonical, swap the body, then wire it in. Four places, every time: `sitemap.xml`, the
  `<nav class="site-nav">` block, the first footer paragraph, and the "Related guides" grid
  on whichever pages it genuinely belongs next to. The nav and footer blocks are byte-identical
  across all twelve pages on purpose — keep them that way, and set `aria-current="page"` on the
  page you are adding. Run `check-site.py` — it will tell you which pages are now missing a link.
- **The diagrams are hand-drawn SVG**, not screenshots. They illustrate concepts (the ribbon
  tabs, how a Slide Master cascades, the three animation Start settings) rather than showing
  the real UI. Edit them as text; they are readable and self-contained.
- **Keyboard shortcuts** use `<span class="keys">`. Menu paths are written with `→`
  (e.g. `File → Info → Compress Media`) rather than platform-specific names.
- **The tool page's prose is load-bearing.** It is what separates a tool that ranks from a
  bare widget: what the numbers mean, how to read the report, the manual `.zip` method for
  people who would rather not run a tool, and why it runs in the browser. Do not trim it.
