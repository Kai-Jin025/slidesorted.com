/* Tests for pptx-inspector.js.
 *
 * Python's zipfile builds the fixtures and records what it believes is inside
 * them; this compares the browser reader against that independent answer. If
 * the two disagree about a size or an offset, the byte arithmetic in
 * readDirectory is wrong.
 *
 *   python tests/make-fixtures.py && node tests/test-inspector.js
 */

'use strict';

const fs = require('fs');
const path = require('path');
const inspector = require('../pptx-inspector.js');

const FIXTURES = path.join(__dirname, 'fixtures');

let failures = 0;
let checks = 0;

function ok(condition, label, detail) {
  checks++;
  if (!condition) {
    failures++;
    console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
  }
}

function eq(actual, expected, label) {
  ok(actual === expected, label,
     actual === expected ? '' : 'expected ' + JSON.stringify(expected) +
                                 ', got ' + JSON.stringify(actual));
}

function load(file) {
  const buf = fs.readFileSync(path.join(FIXTURES, file));
  // Hand over a plain ArrayBuffer, exactly as FileReader does in the browser.
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

function readJSON(file) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, file), 'utf8'));
}

/* ------------------------------------------------------------------ deck --- */

console.log('\nsample-deck.pptx — reader vs python zipfile');

const deckBuf = load('sample-deck.pptx');
const expected = readJSON('sample-deck.expected.json');
const entries = inspector.readDirectory(deckBuf);

ok(entries !== null, 'readDirectory returns a result');
eq(entries.length, expected.length, 'entry count');

// Compare as a set keyed by name — order is not part of the contract.
const got = new Map(entries.map(e => [e.name, e]));
for (const want of expected) {
  const have = got.get(want.name);
  if (!have) { ok(false, 'missing entry ' + want.name); continue; }
  eq(have.size, want.size, 'compressed size of ' + want.name);
  eq(have.raw, want.raw, 'uncompressed size of ' + want.name);
  eq(have.kind, want.kind, 'kind of ' + want.name);
}

// Names must survive UTF-8 decoding intact.
ok(entries.every(e => typeof e.name === 'string' && e.name.length > 0),
   'every entry has a non-empty name');

/* ---------------------------------------------------------- classification -- */

console.log('\nclassification');

const cases = [
  ['ppt/media/movie.mp4', 'video'],
  ['ppt/media/clip.MP4', 'video'],
  ['ppt/media/sound.mp3', 'audio'],
  ['ppt/media/photo.png', 'image'],
  ['ppt/media/scan.tiff', 'image'],
  ['ppt/media/unknown.bin', 'other'],
  ['ppt/embeddings/oleObject1.xlsx', 'embedding'],
  ['ppt/fonts/font1.fntdata', 'font'],
  ['ppt/media/image1.png', 'image'],
  ['ppt/slides/slide1.xml', 'slide'],
  ['ppt/slides/slide12.xml', 'slide'],
  ['ppt/slideLayouts/slideLayout1.xml', 'other'],
  ['ppt/notesSlides/notesSlide1.xml', 'other'],
  ['ppt/media/', 'other'],
  ['', 'other']
];
for (const [name, kind] of cases) {
  eq(inspector.classify(name), kind, 'classify(' + JSON.stringify(name) + ')');
}

/* ---------------------------------------------------------------- totals --- */

console.log('\nsummary and verdict');

const fileSize = deckBuf.byteLength;
const s = inspector.summarise(entries, fileSize);

const mediaExpected = expected
  .filter(e => e.name.startsWith('ppt/media/'))
  .reduce((a, e) => a + e.size, 0);
eq(s.media, mediaExpected, 'media total matches the sum of ppt/media/ entries');
eq(s.slides, 12, 'slide count');

const videoExpected = expected.find(e => e.name === 'ppt/media/media1.mp4').size;
eq(s.by.video, videoExpected, 'video total');
eq(s.av, s.by.video + s.by.audio, 'audio+video total');

ok(s.mediaFiles.every((e, i, a) => i === 0 || a[i - 1].size >= e.size),
   'media files are sorted largest first');
ok(s.otherBig.every(e => !/^ppt\/media\//.test(e.name)),
   'the non-media list excludes media');
ok(s.otherBig.every(e => !/^ppt\/slides\/slide\d+\.xml$/.test(e.name)),
   'the non-media list excludes slide XML');

// Nothing may be counted twice.
const accounted = s.media + s.by.font + s.by.embedding +
                  s.by.slide + s.by.other;
eq(accounted, entries.reduce((a, e) => a + e.size, 0),
   'every byte is counted in exactly one bucket');

const v = inspector.verdicts(s);
eq(v[0].tone, 'hot', 'video-dominated deck is flagged as the main problem');
// The fixture has both a video and an audio file, so the headline must say so
// rather than attributing the combined figure to video alone.
ok(/^Video and audio are your problem/.test(v[0].head),
   'verdict names both video and audio when both are present',
   'got: ' + v[0].head);
ok(v.some(x => /embedded workbook/i.test(x.head)),
   'the embedded workbook is called out separately');
ok(v.some(x => /embedded fonts/i.test(x.head)), 'the embedded fonts are called out');

// The headline figure must match what the headline claims it is.
const avBytes = s.by.video + s.by.audio;
ok(v[0].head.indexOf(inspector.formatBytes(avBytes)) > -1,
   'the headline size equals the video+audio total',
   'expected ' + inspector.formatBytes(avBytes) + ' in: ' + v[0].head);

// Each lead wording, exercised on a deck built for it.
const only = (kind, size) => inspector.summarise(
  [{ name: 'ppt/media/m.' + (kind === 'video' ? 'mp4' : 'mp3'),
     size: size, raw: size, kind: kind }], Math.round(size * 1.1));
ok(/^Video is your problem/.test(inspector.verdicts(only('video', 9000))[0].head),
   'a video-only deck says "Video is"');
ok(/^Audio is your problem/.test(inspector.verdicts(only('audio', 9000))[0].head),
   'an audio-only deck says "Audio is", not "Video is"');

// The non-media list must not fill up with tiny XML parts.
const manyXml = [{ name: 'ppt/media/image1.png', size: 500000, raw: 500000, kind: 'image' }];
for (let i = 0; i < 40; i++) {
  manyXml.push({ name: 'ppt/slides/slide' + i + '.xml', size: 300, raw: 3000, kind: 'other' });
}
const many = inspector.summarise(manyXml, 520000);
eq(many.otherBig.length, 0, 'sub-1% XML parts are kept out of the non-media list');

// A deck with no media at all should not invent a media problem.
const noMedia = inspector.summarise(
  [{ name: 'ppt/slides/slide1.xml', size: 900, raw: 4000, kind: 'slide' }], 1200);
const nv = inspector.verdicts(noMedia);
ok(nv.some(x => /No embedded media/.test(x.head)),
   'a deck with no media says so instead of blaming media');

// Media present but small must not be blamed.
const small = inspector.summarise([
  { name: 'ppt/slides/slide1.xml', size: 900, raw: 4000, kind: 'slide' },
  { name: 'ppt/media/image1.png', size: 100, raw: 100, kind: 'image' }
], 100000);
ok(inspector.verdicts(small).some(x => /only/.test(x.head)),
   'media under 40% of the file is reported as not the problem');

/* ------------------------------------------------------------ formatting --- */

console.log('\nformatting');

const sizes = [
  [0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1.0 KB'],
  [1536, '1.5 KB'], [10240, '10 KB'], [1048576, '1.0 MB'],
  [3400000, '3.2 MB'], [1073741824, '1.0 GB']
];
for (const [n, want] of sizes) {
  eq(inspector.formatBytes(n), want, 'formatBytes(' + n + ')');
}

/* --------------------------------------------------------------- zip64 ----- */

console.log('\nzip64.zip — entry count past the 16-bit limit');

const z64Buf = load('zip64.zip');
const z64Expected = readJSON('zip64.expected.json');
const z64 = inspector.readDirectory(z64Buf);

ok(z64 !== null, 'readDirectory handles a ZIP64 archive');
eq(z64.length, z64Expected.length, 'ZIP64 entry count (past 65535)');

let z64Mismatch = 0;
for (let i = 0; i < z64Expected.length; i++) {
  if (z64[i].name !== z64Expected[i].name || z64[i].size !== z64Expected[i].size) {
    z64Mismatch++;
  }
}
eq(z64Mismatch, 0, 'every ZIP64 entry matches python zipfile');
eq(z64[69999].name, 'ppt/slides/slide69999.xml', 'the last ZIP64 entry is readable');

/* --------------------------------------------------------- not-a-zip ------- */

console.log('\nrejects non-archives');

eq(inspector.readDirectory(new ArrayBuffer(64)), null,
   'a buffer that is not a zip returns null');
eq(inspector.readDirectory(new ArrayBuffer(0)), null, 'an empty buffer returns null');

const wrongMagic = new ArrayBuffer(200);
new Uint8Array(wrongMagic).fill(0x41);
eq(inspector.readDirectory(wrongMagic), null, 'arbitrary bytes return null');

/* ---------------------------------------------------------------- result --- */

console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' +
            (checks - failures) + '/' + checks + ' checks passed');

if (failures) process.exit(1);
