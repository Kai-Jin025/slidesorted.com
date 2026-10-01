"""Build synthetic .pptx archives for testing pptx-inspector.js.

These are not opened by PowerPoint and are not meant to be. They reproduce the
internal shape of a real deck — XML parts that deflate well, media parts that do
not — so the ZIP reader is exercised against the same structures it will meet in
the wild.

Run:  python tests/make-fixtures.py
Then: node tests/test-inspector.js
"""

import json
import os
import random
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "fixtures")

# Seeded so the fixtures are byte-identical between runs and a failure means the
# code changed, not the input.
rng = random.Random(20261001)


def noise(n):
    """Incompressible bytes, like a JPEG or an MP4 payload."""
    return bytes(rng.getrandbits(8) for _ in range(n))


def xml(n):
    """Highly compressible bytes, like slide XML."""
    return (b'<?xml version="1.0"?><p:sld><p:cSld><p:spTree>' +
            b'<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/>' * (n // 60 + 1) +
            b'</p:spTree></p:cSld></p:sld>')


# name -> (bytes, expected kind once classified by the JS)
DECK = [
    ("[Content_Types].xml",                       xml(4000),  "other"),
    ("_rels/.rels",                               xml(900),   "other"),
    ("docProps/thumbnail.jpeg",                   noise(12000), "other"),
    ("ppt/presentation.xml",                      xml(6000),  "other"),
    ("ppt/presProps.xml",                         xml(1200),  "other"),
    ("ppt/viewProps.xml",                         xml(3000),  "other"),
    ("ppt/tableStyles.xml",                       xml(2000),  "other"),
    ("ppt/theme/theme1.xml",                      xml(9000),  "other"),
    ("ppt/slideLayouts/slideLayout1.xml",         xml(7000),  "other"),
    ("ppt/slideMasters/slideMaster1.xml",         xml(11000), "other"),
    ("ppt/notesSlides/notesSlide1.xml",           xml(2400),  "other"),
    ("ppt/notesSlides/notesSlide2.xml",           xml(2500),  "other"),
    # Media — the point of the whole tool.
    ("ppt/media/media1.mp4",                      noise(3_400_000), "video"),
    ("ppt/media/media2.mp3",                      noise(410_000),   "audio"),
    ("ppt/media/image1.png",                      noise(1_150_000), "image"),
    ("ppt/media/image2.jpg",                      noise(260_000),   "image"),
    ("ppt/media/image3.emf",                      noise(38_000),    "image"),
    ("ppt/media/image4.gif",                      noise(9_500),     "image"),
    # Non-media things that also bloat a deck.
    ("ppt/embeddings/oleObject1.xlsx",            noise(185_000),   "embedding"),
    ("ppt/fonts/font1.fntdata",                   noise(64_000),    "font"),
    ("ppt/slides/_rels/slide1.xml.rels",          xml(700),   "other"),
]
DECK += [("ppt/slides/slide%d.xml" % i, xml(5200), "slide") for i in range(1, 13)]
DECK += [("ppt/slides/_rels/slide%d.xml.rels" % i, xml(700), "other") for i in range(2, 13)]


def build_deck(path):
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
        for name, data, _ in DECK:
            z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)

    # The oracle: what Python's own zipfile thinks is in there.
    with zipfile.ZipFile(path) as z:
        expected = [
            {
                "name": i.filename,
                "size": i.compress_size,      # what the tool reports
                "raw": i.file_size,           # uncompressed, for the record
                "kind": dict((n, k) for n, _, k in DECK)[i.filename],
            }
            for i in z.infolist()
        ]
    return expected


def build_zip64(path, entries=70000):
    """Force the ZIP64 end-of-directory: the 16-bit entry count saturates at
    65535, so a larger archive moves the real values into a ZIP64 record. That
    branch is the riskiest code in the reader and is otherwise untestable with a
    realistic .pptx."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_STORED, allowZip64=True) as z:
        for i in range(entries):
            z.writestr("ppt/slides/slide%d.xml" % i, b"<x/>")
    with zipfile.ZipFile(path) as z:
        return [{"name": i.filename, "size": i.compress_size, "raw": i.file_size}
                for i in z.infolist()]


def main():
    os.makedirs(OUT, exist_ok=True)

    deck = os.path.join(OUT, "sample-deck.pptx")
    expected = build_deck(deck)
    with open(os.path.join(OUT, "sample-deck.expected.json"), "w", encoding="utf-8") as f:
        json.dump(expected, f, indent=1)

    total = os.path.getsize(deck)
    media = sum(e["size"] for e in expected
                if e["name"].startswith("ppt/media/"))
    print("sample-deck.pptx      %8d bytes, %d entries" % (total, len(expected)))
    print("  media               %8d bytes (%.1f%% of file)" % (media, media / total * 100))
    print("  video               %8d bytes" % sum(
        e["size"] for e in expected if e["kind"] == "video"))

    z64 = os.path.join(OUT, "zip64.zip")
    z64_expected = build_zip64(z64)
    with open(os.path.join(OUT, "zip64.expected.json"), "w", encoding="utf-8") as f:
        json.dump(z64_expected, f, indent=1)
    print("zip64.zip             %8d bytes, %d entries" % (os.path.getsize(z64), len(z64_expected)))


if __name__ == "__main__":
    main()
