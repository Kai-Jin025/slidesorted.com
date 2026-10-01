/* Exercises the DOM-building half of pptx-inspector.js.
 *
 * The parser tests prove the numbers are right; these prove the report can
 * actually be drawn. The page's element ids are read out of the real HTML
 * rather than hard-coded here, so renaming an id in the page without renaming
 * it in the script fails the build instead of throwing in a user's browser.
 *
 *   python tests/make-fixtures.py && node tests/test-render.js
 */

'use strict';

const fs = require('fs');
const path = require('path');

// The page can be overridden so the coupling to the markup can itself be
// tested: point it at a copy with an id renamed and these checks must fail.
const PAGE = process.argv[2] || path.join(__dirname, '..', 'powerpoint-file-size-checker.html');
const html = fs.readFileSync(PAGE, 'utf8');

/* ------------------------------------------------------------- DOM stub --- */

let nodeCount = 0;

function makeNode(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    children: [],
    attrs: {},
    hidden: false,
    listeners: {},
    _text: '',
    get textContent() { return this._text; },
    set textContent(v) {
      this._text = String(v);
      this.children.length = 0;           // assigning textContent drops children
    },
    appendChild(child) { this.children.push(child); return child; },
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
    click() { (this.listeners.click || []).forEach(fn => fn({})); },
    scrollIntoView() {},
    // Only the one selector the script actually uses.
    querySelector(sel) {
      if (sel !== 'tbody') throw new Error('stub cannot evaluate selector: ' + sel);
      return this.children.find(c => c.tagName === 'TBODY') || null;
    }
  };
  nodeCount++;
  return node;
}

function walk(node, fn) {
  fn(node);
  node.children.forEach(c => walk(c, fn));
}

/* Pull every id out of the page so the stub matches the real markup. */
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
const registry = new Map();
ids.forEach(id => registry.set(id, makeNode('div')));

// The two tables need a tbody, because render() reaches for one.
['files', 'others'].forEach(id => {
  if (registry.has(id)) registry.get(id).appendChild(makeNode('tbody'));
});

const documentStub = {
  readyState: 'complete',
  createElement: makeNode,
  getElementById: id => registry.get(id) || null,
  addEventListener() {}
};

global.document = documentStub;
global.window = { addEventListener() {} };

if (!registry.has('drop') || !registry.has('picker') || !registry.has('reset')) {
  console.log('FAIL — the page is missing an element the script binds to');
  process.exit(1);
}

const inspector = require('../pptx-inspector.js');

let failures = 0, checks = 0;
function ok(cond, label, detail) {
  checks++;
  if (!cond) { failures++; console.log('  FAIL  ' + label + (detail ? '\n        ' + detail : '')); }
}

/* Fetch a stubbed element by the id the script expects. A missing id means the
   page and the script have drifted apart — report that as a failure rather
   than letting it throw as a TypeError somewhere further down. */
function el(id) {
  const node = registry.get(id);
  if (!node) {
    checks++; failures++;
    // Ids close to the one asked for, to make the typo obvious.
    const near = [...registry.keys()].filter(k => k.startsWith(id.slice(0, 4)));
    console.log('  FAIL  the page has no element with id="' + id + '"' +
                (near.length ? '\n        did you mean: ' + near.join(', ') : ''));
    return makeNode('div');            // keep going so later checks still report
  }
  return node;
}

/* --------------------------------------------------------------- render --- */

const deckPath = path.join(__dirname, 'fixtures', 'sample-deck.pptx');
if (!fs.existsSync(deckPath)) {
  console.log('FAIL — run `python tests/make-fixtures.py` first');
  process.exit(1);
}
const buf = fs.readFileSync(deckPath);
const entries = inspector.readDirectory(
  buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
const result = inspector.summarise(entries, buf.byteLength);

console.log('\nrender() against the real page markup');

let threw = null;
try {
  inspector.render(result, 'quarterly-review.pptx');
} catch (e) {
  threw = e;
}
ok(!threw, 'render() completes without throwing', threw && threw.stack);

if (!threw) {
  ok(el('tool-input').hidden === true, 'the drop zone is hidden after a render');
  ok(el('tool-output').hidden === false, 'the report is revealed');

  const name = el('file-name');
  ok(name.textContent === 'quarterly-review.pptx', 'the file name is shown');
  ok(/5\.3 MB/.test(el('file-meta').textContent), 'the headline size is shown',
     'got: ' + el('file-meta').textContent);
  ok(/12 slides/.test(el('file-meta').textContent), 'the slide count is shown',
     'got: ' + el('file-meta').textContent);

  const stats = el('stats');
  ok(stats.children.length === 3, 'three headline figures are drawn');
  ok(/\d/.test(stats.children[0]._text + stats.children[0].children.map(c => c.textContent).join('')),
     'the first figure has a value in it');

  const verdicts = el('verdict');
  ok(verdicts.children.length > 0, 'at least one verdict is drawn');
  ok(verdicts.children.every(v => v.children.length === 2),
     'each verdict has a heading and a body');

  const bars = el('breakdown');
  ok(bars.children.length > 0, 'breakdown bars are drawn');
  ok(bars.children.every(b => b.children.length === 3),
     'each bar has a label, a track and a value');
  const rawWidths = bars.children.map(b => b.children[1].children[0].style.width);
  const widths = rawWidths.map(parseFloat);
  ok(widths.every(w => w > 0 && w <= 100), 'every bar width is a sane percentage',
     'widths: ' + widths.join(', '));
  ok(widths[0] === 100, 'the largest category is drawn full width');
  // A raw float like 42.86791687248606% works but should not reach the DOM.
  ok(rawWidths.every(w => /^\d+(\.\d)?%$/.test(w)),
     'bar widths are rounded to one decimal place', 'got: ' + rawWidths.join(', '));

  const mediaRows = el('files').querySelector('tbody').children;
  ok(mediaRows.length === result.mediaFiles.length,
     'one row per media file (' + result.mediaFiles.length + ')');
  ok(mediaRows.every(r => r.children.length === 4), 'each media row has four cells');
  ok(el('files-block').hidden === false, 'the media table is shown');

  const otherRows = el('others').querySelector('tbody').children;
  ok(otherRows.length > 0, 'the non-media table lists something');
  ok(otherRows.length <= 12, 'the non-media table is capped at 12 rows');

  // Every string drawn must be a string, never undefined leaking into the UI.
  let bad = [];
  registry.forEach((node, id) => {
    walk(node, n => {
      if (/undefined|NaN|\[object/.test(n._text)) bad.push(id + ': ' + n._text);
    });
  });
  ok(bad.length === 0, 'nothing renders as undefined/NaN', bad.join(' | '));
}

/* ---------------------------------------------------------------- fail() --- */

console.log('\nfail() path');

try { inspector.render(result, 'x.pptx'); } catch (e) { /* asserted above */ }
inspector.fail('That is not a PowerPoint file.');
ok(el('tool-input').hidden === false, 'the drop zone comes back on error');
ok(el('tool-output').hidden === true, 'the stale report is hidden on error');
ok(el('tool-error').hidden === false, 'the error is shown');
ok(/not a PowerPoint file/.test(el('tool-error').textContent), 'the message is shown');
ok(el('tool-error')._text.length > 0, 'the error text is set via textContent');

/* -------------------------------------------------- hostile file names ---- */

console.log('\nhostile input cannot reach the DOM as markup');

try {
  inspector.render(result,
    '<img src=x onerror=alert(1)>.pptx</script><script>alert(2)</script>');
} catch (e) { /* the render assertions above already reported any breakage */ }

const drawn = [];
registry.forEach(node => walk(node, n => { if (n._text) drawn.push(n._text); }));
const joined = drawn.join('\n');
ok(joined.includes('<img src=x onerror=alert(1)>'),
   'the name is stored verbatim, as text');
ok(!drawn.some(t => /innerHTML/.test(t)), 'no innerHTML is used anywhere');
// The stub has no HTML parser, so the real guarantee is that the script only
// ever assigns textContent. Assert that directly on the source.
const src = fs.readFileSync(path.join(__dirname, '..', 'pptx-inspector.js'), 'utf8');
ok(!/\.innerHTML\s*=/.test(src), 'the source contains no innerHTML assignment');
ok(!/insertAdjacentHTML|document\.write|outerHTML/.test(src),
   'the source contains no other HTML injection sink');

/* ---------------------------------------------------------------- result -- */

console.log('\n' + (failures ? 'FAIL' : 'PASS') + ' — ' +
            (checks - failures) + '/' + checks + ' checks passed' +
            ' (' + nodeCount + ' stub nodes)');

if (failures) process.exit(1);
