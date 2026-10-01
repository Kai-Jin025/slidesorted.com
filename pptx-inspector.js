/* ==========================================================================
   PowerPoint File Size Checker
   --------------------------------------------------------------------------
   Reports what is making a .pptx large, entirely in the browser.

   A .pptx is a ZIP archive. The ZIP central directory records the compressed
   and uncompressed size of every member, so this never has to inflate a single
   byte of the file: it reads the directory and reports from that. That keeps
   it instant even on a 200 MB deck, and it means the file never leaves the
   machine — there is no upload step and no server to upload to.

   Everything below treats the file as untrusted input. Nothing read out of the
   archive is inserted as HTML; it goes in through textContent.
   ========================================================================== */

(function () {
  'use strict';

  var VIDEO = ['mp4', 'm4v', 'mov', 'avi', 'wmv', 'mpg', 'mpeg', 'webm', 'mkv'];
  var AUDIO = ['mp3', 'm4a', 'wav', 'wma', 'aac', 'ogg', 'aiff', 'mid'];
  var IMAGE = ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'emf', 'wmf', 'svg', 'ico'];
  var FONT  = ['fntdata', 'ttf', 'otf', 'eot', 'woff', 'woff2'];
  var EMBED = ['xlsx', 'xls', 'xlsm', 'docx', 'doc', 'pptx', 'ppt', 'vsdx', 'bin'];

  var KIND = {
    video:     { label: 'Video',         cls: 'k-video' },
    audio:     { label: 'Audio',         cls: 'k-audio' },
    image:     { label: 'Image',         cls: 'k-image' },
    font:      { label: 'Font',          cls: 'k-font'  },
    embedding: { label: 'Embedded file', cls: 'k-embed' },
    slide:     { label: 'Slide',         cls: 'k-slide' },
    other:     { label: 'Other',         cls: 'k-other' }
  };

  /* ---------------------------------------------------------------- helpers */

  function ext(name) {
    var i = name.lastIndexOf('.');
    return i < 0 ? '' : name.slice(i + 1).toLowerCase();
  }

  function classify(name) {
    var e = ext(name);
    if (name.indexOf('ppt/media/') === 0) {
      if (VIDEO.indexOf(e) >= 0) return 'video';
      if (AUDIO.indexOf(e) >= 0) return 'audio';
      if (IMAGE.indexOf(e) >= 0) return 'image';
      return 'other';
    }
    if (name.indexOf('ppt/embeddings/') === 0) return 'embedding';
    if (name.indexOf('ppt/fonts/') === 0) return 'font';
    if (FONT.indexOf(e) >= 0 && name.indexOf('ppt/') === 0) return 'font';
    if (/^ppt\/slides\/slide\d+\.xml$/.test(name)) return 'slide';
    return 'other';
  }

  function formatBytes(n) {
    if (n < 1024) return n + ' B';
    var units = ['KB', 'MB', 'GB'], v = n / 1024, i = 0;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return (v < 10 ? v.toFixed(1) : Math.round(v)) + ' ' + units[i];
  }

  function pct(part, whole) {
    if (!whole) return '0%';
    var p = (part / whole) * 100;
    return (p < 1 && p > 0 ? '<1' : p.toFixed(p < 10 ? 1 : 0)) + '%';
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;   // never innerHTML
    return n;
  }

  function utf8(dv, off, len) {
    var bytes = new Uint8Array(dv.buffer, dv.byteOffset + off, len);
    if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[i]);
    return s;
  }

  /* ------------------------------------------------------- the zip directory */

  /* Walks the central directory and returns one record per member. Sizes come
     straight out of the directory, so nothing is decompressed. Returns null
     when the buffer is not a zip at all. */
  function readDirectory(buf) {
    var dv = new DataView(buf);
    var n = buf.byteLength;

    // End of central directory: signature, then up to 64 KB of trailing comment.
    var eocd = -1;
    var floor = Math.max(0, n - 65557);
    for (var i = n - 22; i >= floor; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) return null;

    var count = dv.getUint16(eocd + 10, true);
    var cdOffset = dv.getUint32(eocd + 16, true);

    // Zip64: the 32-bit fields saturate and the real values live in a separate
    // record just before the end-of-directory. A .pptx this large is
    // unrealistic, but reporting a wrong number would be worse than the code.
    if (count === 0xffff || cdOffset === 0xffffffff) {
      var loc = eocd - 20;
      if (loc >= 0 && dv.getUint32(loc, true) === 0x07064b50) {
        var z = Number(dv.getBigUint64(loc + 8, true));
        if (z + 56 <= n && dv.getUint32(z, true) === 0x06064b50) {
          count = Number(dv.getBigUint64(z + 32, true));
          cdOffset = Number(dv.getBigUint64(z + 48, true));
        }
      }
    }

    var out = [];
    var p = cdOffset;
    for (var k = 0; k < count && p + 46 <= n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;   // not a directory header
      var compSize = dv.getUint32(p + 20, true);
      var rawSize = dv.getUint32(p + 24, true);
      var nameLen = dv.getUint16(p + 28, true);
      var extraLen = dv.getUint16(p + 30, true);
      var cmtLen = dv.getUint16(p + 32, true);
      var name = utf8(dv, p + 46, nameLen);

      // Zip64 extended information, present only for the fields that overflowed.
      var ep = p + 46 + nameLen, end = ep + extraLen;
      while (ep + 4 <= end) {
        var hid = dv.getUint16(ep, true), hsz = dv.getUint16(ep + 2, true);
        if (hid === 0x0001) {
          var q = ep + 4;
          if (rawSize === 0xffffffff && q + 8 <= end) { rawSize = Number(dv.getBigUint64(q, true)); q += 8; }
          if (compSize === 0xffffffff && q + 8 <= end) { compSize = Number(dv.getBigUint64(q, true)); q += 8; }
          break;
        }
        ep += 4 + hsz;
      }

      out.push({ name: name, size: compSize, raw: rawSize, kind: classify(name) });
      p += 46 + nameLen + extraLen + cmtLen;
    }
    return out;
  }

  /* ------------------------------------------------------------- the report */

  function summarise(entries, fileSize) {
    var by = { video: 0, audio: 0, image: 0, font: 0, embedding: 0, slide: 0, other: 0 };
    var mediaFiles = [], slides = 0, otherBig = [];

    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      by[e.kind] += e.size;
      if (e.kind === 'slide') slides++;
      if (e.kind === 'video' || e.kind === 'audio' || e.kind === 'image') mediaFiles.push(e);
      if (e.kind !== 'video' && e.kind !== 'audio' && e.kind !== 'image' &&
          e.kind !== 'slide' && e.size > 0) otherBig.push(e);
    }

    mediaFiles.sort(function (a, b) { return b.size - a.size; });
    otherBig.sort(function (a, b) { return b.size - a.size; });

    // A real deck holds hundreds of XML parts of a few hundred bytes each, and a
    // table of those tells the reader nothing. Only parts worth a second look —
    // 1% of the file — make the list.
    var floor = fileSize * 0.01;
    otherBig = otherBig.filter(function (e) { return e.size >= floor; });

    var media = by.video + by.audio + by.image;

    return {
      entries: entries, fileSize: fileSize, by: by, media: media,
      mediaFiles: mediaFiles, otherBig: otherBig, slides: slides,
      av: by.video + by.audio
    };
  }

  function verdicts(d) {
    var out = [];
    var mediaShare = d.fileSize ? d.media / d.fileSize : 0;

    if (d.media === 0) {
      out.push({
        tone: 'plain',
        head: 'No embedded media found.',
        body: 'There is no video, audio or image stored inside this file, so compression tools ' +
              'have nothing to work on. Whatever is making this deck large is something else.'
      });
    } else if (d.av > d.by.image && d.av > d.media * 0.5) {
      // Name whichever of the two is actually present. Saying "video" over a
      // combined video-and-audio figure is the kind of small wrongness that
      // makes a reader distrust the rest of the report.
      var kinds = [];
      if (d.by.video > 0) kinds.push('video');
      if (d.by.audio > 0) kinds.push('audio');
      var lead = kinds.length > 1 ? 'Video and audio are'
               : kinds[0] === 'audio' ? 'Audio is' : 'Video is';
      out.push({
        tone: 'hot',
        head: lead + ' your problem — ' + formatBytes(d.av) + '.',
        body: 'Re-encoding is the only thing that will move this number: ' +
              pct(d.av, d.fileSize) + ' of the file is audio or video stored exactly as it ' +
              'was imported. In PowerPoint for Windows use File → Info → Compress Media and ' +
              'pick 720p. PowerPoint for Mac has no equivalent, so the clip has to be ' +
              're-encoded before it is inserted.'
      });
      out.push({
        tone: 'warn',
        head: 'Compressing video strips embedded captions and extra audio tracks.',
        body: 'If any clip carries subtitles or a second language track, they are removed along ' +
              'with the pixels. Keep a copy of the original if that matters.'
      });
    } else if (d.by.image > 0) {
      out.push({
        tone: 'hot',
        head: 'Images are your problem — ' + formatBytes(d.by.image) + ' of them.',
        body: 'Images are ' + pct(d.by.image, d.fileSize) + ' of the file. Select any picture, ' +
              'then use Picture Format → Compress Pictures. Untick "Apply only to this picture" ' +
              'so it covers the whole deck, and tick "Delete cropped areas of pictures" — that ' +
              'second checkbox is the one people miss.'
      });
    }

    if (d.by.embedding > d.fileSize * 0.03) {
      out.push({
        tone: 'warn',
        head: 'An embedded workbook is travelling with the deck — ' + formatBytes(d.by.embedding) + '.',
        body: 'An embedded Excel object carries a copy of the whole spreadsheet inside the .pptx. ' +
              'Pasting the chart as a picture, or linking it instead, removes it from the file ' +
              'entirely.'
      });
    }

    if (d.by.font > 0) {
      out.push({
        tone: 'warn',
        head: 'This deck has ' + formatBytes(d.by.font) + ' of embedded fonts.',
        body: 'Embedding fonts makes the deck open correctly on machines that lack them, which ' +
              'matters if you use anything unusual. If you do not, untick "Embed fonts in the ' +
              'file" under File → Options → Save.'
      });
    }

    if (mediaShare < 0.4 && d.media > 0) {
      out.push({
        tone: 'plain',
        head: 'Media is only ' + pct(d.media, d.fileSize) + ' of this file.',
        body: 'Compressing media will barely change anything here. The bulk is somewhere else' +
              (d.otherBig.length ? ' — the non-media table below names the largest parts' : '') +
              '. A file saved incrementally for years can carry a surprising amount of ' +
              'accumulated editing history, and File → Save As under a new name discards it.'
      });
    }

    return out;
  }

  /* -------------------------------------------------------------- rendering */

  var $ = function (id) { return document.getElementById(id); };

  function render(result, fileName) {
    var d = result;

    $('tool-input').hidden = true;
    var out = $('tool-output');
    out.hidden = false;

    /* headline */
    $('file-name').textContent = fileName;
    $('file-meta').textContent =
      formatBytes(d.fileSize) + ' · ' + d.slides + ' slide' + (d.slides === 1 ? '' : 's') +
      ' · ' + d.mediaFiles.length + ' media file' + (d.mediaFiles.length === 1 ? '' : 's');

    /* stat cards */
    var stats = $('stats');
    stats.textContent = '';
    [
      ['Whole file', formatBytes(d.fileSize), ''],
      ['Media folder', formatBytes(d.media), pct(d.media, d.fileSize) + ' of the file'],
      ['Everything else', formatBytes(d.fileSize - d.media),
       pct(d.fileSize - d.media, d.fileSize) + ' of the file']
    ].forEach(function (row) {
      var c = el('div', 'stat');
      c.appendChild(el('span', 'stat__label', row[0]));
      c.appendChild(el('strong', 'stat__value', row[1]));
      c.appendChild(el('span', 'stat__note', row[2]));
      stats.appendChild(c);
    });

    /* verdicts */
    var v = $('verdict');
    v.textContent = '';
    verdicts(d).forEach(function (item) {
      var box = el('div', 'verdict verdict--' + item.tone);
      box.appendChild(el('strong', null, item.head));
      box.appendChild(el('p', null, item.body));
      v.appendChild(box);
    });

    /* breakdown bars, biggest kind first */
    var bars = $('breakdown');
    bars.textContent = '';
    var kinds = Object.keys(d.by)
      .filter(function (k) { return d.by[k] > 0 && k !== 'other'; })
      .sort(function (a, b) { return d.by[b] - d.by[a]; });

    var max = kinds.length ? d.by[kinds[0]] : 1;
    kinds.forEach(function (k) {
      var row = el('div', 'bar');
      row.appendChild(el('span', 'bar__label', KIND[k].label));
      var track = el('div', 'bar__track');
      var fill = el('div', 'bar__fill ' + KIND[k].cls);
      fill.style.width = Math.max(1.5, Math.round((d.by[k] / max) * 1000) / 10) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'bar__value', formatBytes(d.by[k])));
      bars.appendChild(row);
    });

    /* file table */
    var tbody = $('files').querySelector('tbody');
    tbody.textContent = '';
    d.mediaFiles.forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', null, e.name.replace(/^ppt\/media\//, '')));
      var k = el('td'); k.appendChild(el('span', 'tag ' + KIND[e.kind].cls, KIND[e.kind].label));
      tr.appendChild(k);
      tr.appendChild(el('td', 'num', formatBytes(e.size)));
      tr.appendChild(el('td', 'num', pct(e.size, d.fileSize)));
      tbody.appendChild(tr);
    });
    $('files-block').hidden = d.mediaFiles.length === 0;

    var otbody = $('others').querySelector('tbody');
    otbody.textContent = '';
    d.otherBig.slice(0, 12).forEach(function (e) {
      var tr = el('tr');
      tr.appendChild(el('td', null, e.name));
      tr.appendChild(el('td', 'num', formatBytes(e.size)));
      tr.appendChild(el('td', 'num', pct(e.size, d.fileSize)));
      otbody.appendChild(tr);
    });
    $('others-block').hidden = d.otherBig.length === 0;
  }

  function fail(message) {
    $('tool-input').hidden = false;
    $('tool-output').hidden = true;
    var box = $('tool-error');
    box.textContent = message;
    box.hidden = false;
  }

  /* ------------------------------------------------------------------ wiring */

  function handle(file) {
    if (!file) return;
    $('tool-error').hidden = true;

    if (/\.ppt$/i.test(file.name)) {
      fail('That is a legacy .ppt file, which is not zip-based and cannot be read this way. ' +
           'Open it in PowerPoint and save it as .pptx first.');
      return;
    }
    if (file.size > 400 * 1024 * 1024) {
      fail('That file is over 400 MB. Reading it in the browser would use a lot of memory — ' +
           'try one of the smaller decks first.');
      return;
    }

    $('drop').classList.add('is-busy');

    var reader = new FileReader();
    reader.onerror = function () {
      $('drop').classList.remove('is-busy');
      fail('The file could not be read. If it is on a network drive, copy it locally first.');
    };
    reader.onload = function () {
      $('drop').classList.remove('is-busy');
      var entries;
      try {
        entries = readDirectory(reader.result);
      } catch (err) {
        fail('That file could not be parsed as an archive.');
        return;
      }
      if (!entries) {
        fail('That does not look like a PowerPoint file. A .pptx or .potx is a zip archive; ' +
             'this file is not, so it may be corrupt or simply a different file type.');
        return;
      }
      if (!entries.some(function (e) { return e.name.indexOf('ppt/') === 0; })) {
        fail('That archive does not contain a ppt/ folder, so it is not a PowerPoint file. ' +
             'It may be a Word or Excel document.');
        return;
      }
      render(summarise(entries, file.size), file.name);
    };
    reader.readAsArrayBuffer(file);
  }

  function init() {
    var drop = $('drop');
    var input = $('picker');
    if (!drop || !input) return;

    drop.addEventListener('click', function () { input.click(); });
    drop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); }
    });
    input.addEventListener('change', function () { handle(input.files[0]); });

    ['dragenter', 'dragover'].forEach(function (t) {
      drop.addEventListener(t, function (e) {
        e.preventDefault(); drop.classList.add('is-over');
      });
    });
    ['dragleave', 'drop'].forEach(function (t) {
      drop.addEventListener(t, function (e) {
        e.preventDefault(); drop.classList.remove('is-over');
      });
    });
    drop.addEventListener('drop', function (e) {
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
        handle(e.dataTransfer.files[0]);
      }
    });

    // Dropping anywhere else in the window should not navigate away from the tool.
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('reset').addEventListener('click', function () {
      input.value = '';
      $('tool-output').hidden = true;
      $('tool-error').hidden = true;
      $('tool-input').hidden = false;
      $('tool-input').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }

  // Hand the internals to the test harness. `module` only exists under a CommonJS
  // loader, so this branch is dead in a browser.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      readDirectory: readDirectory,
      summarise: summarise,
      verdicts: verdicts,
      classify: classify,
      formatBytes: formatBytes,
      render: render,
      fail: fail,
      handle: handle
    };
  }

  // Outside a browser there is nothing to wire up.
  if (typeof document === 'undefined') return;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
