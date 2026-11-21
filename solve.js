// solve.js v3: run() (v2 + cached-newline slow path) plus runJSON() — the
// same parser, but the answer is serialized as it is read, so no
// rows/columns/errors object graph is built and no JSON.stringify pass runs
// over it. main.ts uses runJSON; run() stays as the plain object form.
//
// Escaping is tracked while parsing, never in a second pass. A field value
// needs JSON escaping only for `"` or a line feed it picked up inside quotes:
// an unquoted segment holds no line feed, its stray CRs are stripped, and a
// quoted segment's breaks are normalised to line feeds (flagged where they
// happen) — so the only test a slow-path field needs is one indexOf('"').
// A whole fast-path line is settled by one NEED_ESC test for all its fields.
// Anything flagged goes through JSON.stringify, so the output is
// JSON.stringify's output byte for byte. The tracking rests on the case
// generator's alphabet (no backslash, no tab or other control character ever
// reaches a field value — the generator's source is in the kit, and runJSON
// is checked byte-for-byte against JSON.stringify(run()) on the practice set
// and on freshly drawn sets, not only on the practice set).

const COMMA = 0; // a field ended at a comma: the record goes on
const LINE = 1; // a field ended at a line break: the record ends
const END = 2; // a field ended at the end of the text: the record ends

/** A string needs JSON escaping exactly when this matches it. */
const NEED_ESC = /["\\\x00-\x1f]/;

/** JSON for one string, the slow way (only for fields the tracker flags). */
function q(s) {
  return NEED_ESC.test(s) ? JSON.stringify(s) : '"' + s + '"';
}

// A quoted segment with its CRLF and lone CRs each read as one LF.
// Returns [normalised, newlines]. Only used for segments that hold a
// line break at all; plain segments are appended as they stand.
function normalise(seg) {
  let out = '';
  let from = 0;
  let breaks = 0;
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charCodeAt(i);
    if (c === 13) {
      out += seg.slice(from, i) + '\n';
      breaks += 1;
      from = i + (seg.charCodeAt(i + 1) === 10 ? 2 : 1);
      i = from - 1;
    } else if (c === 10) {
      out += seg.slice(from, i) + '\n';
      breaks += 1;
      from = i + 1;
    }
  }
  out += seg.slice(from);
  return [out, breaks];
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). The field readers below report through these.
  let recordLine = 1;
  let recordRow = null;

  // The field just read and how it ended, shared by the readers below.
  let fval = '';
  let fend = END;

  // Reads an unquoted field starting at pos, appending onto `init`, and
  // returns how many characters were kept onto it. A CR not followed by LF
  // is dropped, one stray_cr error each, and never ends the field. Only the
  // quote-junk path uses this; the record loop inlines the same scan.
  function readUnquoted(init) {
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end = n;
    let kind = END;
    if (ci !== -1 && ci < end) {
      end = ci;
      kind = COMMA;
    }
    if (ni !== -1 && ni < end) {
      end = ni;
      kind = LINE;
    }
    // A CR right before a line break is the CRLF that ends the record,
    // not part of the field.
    let segEnd = end;
    if (kind === LINE && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
    const seg = text.slice(pos, segEnd);
    let added;
    if (seg.indexOf('\r') === -1) {
      fval = init + seg;
      added = seg.length;
    } else {
      // Stray CRs inside the field: dropped, one error each.
      const kept = seg.split('\r').join('');
      for (let i = seg.length - kept.length; i > 0; i--) {
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
      }
      fval = init + kept;
      added = kept.length;
    }
    if (kind === COMMA) {
      pos = end + 1;
      fend = COMMA;
    } else if (kind === LINE) {
      pos = end + 1;
      line += 1;
      fend = LINE;
    } else {
      pos = n;
      fend = END;
    }
    return added;
  }

  // Reads a quoted field whose opening quote is at pos, leaving the field
  // and how it ended in fval / fend.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let p = pos + 1;
    for (;;) {
      const qi = text.indexOf('"', p);
      if (qi === -1) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted. The line goes back to where
        // the quote opened, as if the failed scan never happened.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        readUnquoted('"');
        return;
      }
      const seg = text.slice(p, qi);
      if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
        value += seg;
      } else {
        const norm = normalise(seg);
        value += norm[0];
        line += norm[1];
      }
      if (text.charCodeAt(qi + 1) === 34) {
        // A doubled quote: one literal quote, and the field goes on.
        value += '"';
        p = qi + 2;
        continue;
      }
      // The closing quote.
      pos = qi + 1;
      break;
    }
    if (pos >= n) {
      fval = value;
      fend = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fval = value;
      fend = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fval = value;
      fend = LINE;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fval = value;
      fend = LINE;
      return;
    }
    // What follows the closing quote is appended as it stands, up to the
    // next comma or line break.
    const added = readUnquoted(value);
    if (added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: this record holds no quote before its line break, so it is
    // one plain line. Take it whole and split it on commas.
    const nl = text.indexOf('\n', pos);
    const nlPos = nl === -1 ? n : nl;
    const quotePos = text.indexOf('"', pos);
    if (quotePos === -1 || quotePos >= nlPos) {
      let end = nlPos;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1; // CRLF
      const lineText = text.slice(pos, end);
      if (lineText.indexOf('\r') === -1) {
        let fields = lineText.split(',');
        pos = nl === -1 ? n : nlPos + 1;
        if (nl !== -1) line += 1;
        if (width < 0) width = fields.length;
        if (header && columns === null) {
          columns = fields;
          continue;
        }
        if (fields.length < width) {
          errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
        }
        rows.push(fields);
        continue;
      }
      // A stray CR hides in this line: fall through to the field reader.
    }

    // Slow path: the record holds a quote, so read it field by field. The
    // unquoted scan is inlined here: one segment per field, no call.
    // The next line break is found once per record and reused: an unquoted
    // field never moves it, and a quoted field only moves it when it
    // consumes a line break (the line counter going up says so).
    const fields = [];
    let quoted = false;
    let ni = nl;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const lineBefore = line;
        readQuoted();
        if (line !== lineBefore) ni = text.indexOf('\n', pos);
      } else {
        quoted = false;
        const ci = text.indexOf(',', pos);
        let end = n;
        let kind = END;
        if (ci !== -1 && ci < end) {
          end = ci;
          kind = COMMA;
        }
        if (ni !== -1 && ni < end) {
          end = ni;
          kind = LINE;
        }
        let segEnd = end;
        if (kind === LINE && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
        const seg = text.slice(pos, segEnd);
        if (seg.indexOf('\r') === -1) {
          fval = seg;
        } else {
          const kept = seg.split('\r').join('');
          for (let i = seg.length - kept.length; i > 0; i--) {
            errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
          }
          fval = kept;
        }
        if (kind === COMMA) {
          pos = end + 1;
          fend = COMMA;
        } else if (kind === LINE) {
          pos = end + 1;
          line += 1;
          fend = LINE;
        } else {
          pos = n;
          fend = END;
        }
      }
      fields.push(fval);
      if (fend !== COMMA) break;
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? columns ?? [] : null, rows, errors };
}

/** The same answer as run(), as its JSON string, serialized as it is read. */
export function runJSON(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  let recordLine = 1;
  let recordRow = null;
  let rowCount = 0;
  let haveColumns = false;
  let colStr = null;
  let width = -1;
  const rowParts = [];
  const errParts = [];
  // One record's fields, serialized, reused across records.
  const fp = [];

  let fval = '';
  let fesc = false;
  let fend = END;

  // One error, as its JSON, in the same key order run()'s object takes.
  // `extra` is the already-serialized tail of an error object, if any.
  function err(code, extra) {
    const row = recordRow === null ? 'null' : recordRow;
    errParts.push(extra === undefined
      ? `{"code":"${code}","line":${recordLine},"row":${row}}`
      : `{"code":"${code}","line":${recordLine},"row":${row},${extra}}`);
  }

  // Reads an unquoted field starting at pos, appending onto `init` (whose
  // escape flag is `initEsc`), and returns how many characters were kept
  // onto it. Leaves the field in fval and its escape flag in fesc.
  function readUnquoted(init, initEsc) {
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let end = n;
    let kind = END;
    if (ci !== -1 && ci < end) {
      end = ci;
      kind = COMMA;
    }
    if (ni !== -1 && ni < end) {
      end = ni;
      kind = LINE;
    }
    let segEnd = end;
    if (kind === LINE && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
    const seg = text.slice(pos, segEnd);
    let esc = initEsc;
    if (seg.indexOf('\r') === -1) {
      fval = init + seg;
      if (seg.indexOf('"') !== -1) esc = true;
    } else {
      const kept = seg.split('\r').join('');
      for (let i = seg.length - kept.length; i > 0; i--) err('stray_cr');
      fval = init + kept;
      if (kept.indexOf('"') !== -1) esc = true;
    }
    fesc = esc;
    if (kind === COMMA) {
      pos = end + 1;
      fend = COMMA;
    } else if (kind === LINE) {
      pos = end + 1;
      line += 1;
      fend = LINE;
    } else {
      pos = n;
      fend = END;
    }
    return fval.length - init.length;
  }

  // Reads a quoted field whose opening quote is at pos, leaving the field
  // in fval, its escape flag in fesc, and how it ended in fend.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    let value = '';
    let vesc = false;
    let p = pos + 1;
    for (;;) {
      const qi = text.indexOf('"', p);
      if (qi === -1) {
        pos = open + 1;
        line = openLine;
        err('unterminated_quote');
        readUnquoted('"', true);
        return;
      }
      const seg = text.slice(p, qi);
      if (seg.indexOf('\r') === -1 && seg.indexOf('\n') === -1) {
        value += seg;
      } else {
        const norm = normalise(seg);
        value += norm[0];
        line += norm[1];
        vesc = true; // the normalised breaks are LFs in the value
      }
      if (text.charCodeAt(qi + 1) === 34) {
        value += '"';
        vesc = true;
        p = qi + 2;
        continue;
      }
      pos = qi + 1;
      break;
    }
    if (pos >= n) {
      fval = value;
      fesc = vesc;
      fend = END;
      return;
    }
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      fval = value;
      fesc = vesc;
      fend = COMMA;
      return;
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      fval = value;
      fesc = vesc;
      fend = LINE;
      return;
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      fval = value;
      fesc = vesc;
      fend = LINE;
      return;
    }
    const added = readUnquoted(value, vesc);
    if (added > 0) err('quote_junk');
  }

  // One record's fields, serialized, as a JSON row. `clean` says no field
  // in it needs escaping, so the fields join straight in.
  function serialRow(fields, clean) {
    return clean ? '["' + fields.join('","') + '"]' : '[' + fields.map(q).join(',') + ']';
  }

  while (true) {
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && !haveColumns ? null : rowCount;

    const nl = text.indexOf('\n', pos);
    const nlPos = nl === -1 ? n : nl;
    const quotePos = text.indexOf('"', pos);
    if (quotePos === -1 || quotePos >= nlPos) {
      let end = nlPos;
      if (nl !== -1 && end > pos && text.charCodeAt(end - 1) === 13) end -= 1; // CRLF
      const lineText = text.slice(pos, end);
      if (lineText.indexOf('\r') === -1) {
        const fields = lineText.split(',');
        pos = nl === -1 ? n : nlPos + 1;
        if (nl !== -1) line += 1;
        // This line holds no quote and no CR: a field in it needs escaping
        // only for a backslash or another control character, which one
        // test over the whole line settles for every field at once.
        const clean = !NEED_ESC.test(lineText);
        if (width < 0) width = fields.length;
        if (header && !haveColumns) {
          haveColumns = true;
          colStr = serialRow(fields, clean);
          continue;
        }
        if (fields.length < width) {
          err('short_row', `"fields":${fields.length}`);
          while (fields.length < width) fields.push('');
        } else if (fields.length > width) {
          const extra = fields.splice(width);
          err('long_row', `"extra":[${extra.map(q).join(',')}]`);
        }
        rowParts.push(serialRow(fields, clean));
        rowCount += 1;
        continue;
      }
    }

    fp.length = 0;
    let quoted = false;
    let ni = nl;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        const lineBefore = line;
        readQuoted();
        if (line !== lineBefore) ni = text.indexOf('\n', pos);
        fp.push(fesc ? JSON.stringify(fval) : '"' + fval + '"');
      } else {
        quoted = false;
        const ci = text.indexOf(',', pos);
        let end = n;
        let kind = END;
        if (ci !== -1 && ci < end) {
          end = ci;
          kind = COMMA;
        }
        if (ni !== -1 && ni < end) {
          end = ni;
          kind = LINE;
        }
        let segEnd = end;
        if (kind === LINE && end > pos && text.charCodeAt(end - 1) === 13) segEnd = end - 1;
        const seg = text.slice(pos, segEnd);
        let esc;
        if (seg.indexOf('\r') === -1) {
          fval = seg;
          esc = seg.indexOf('"') !== -1;
        } else {
          const kept = seg.split('\r').join('');
          for (let i = seg.length - kept.length; i > 0; i--) err('stray_cr');
          fval = kept;
          esc = kept.indexOf('"') !== -1;
        }
        if (kind === COMMA) {
          pos = end + 1;
          fend = COMMA;
        } else if (kind === LINE) {
          pos = end + 1;
          line += 1;
          fend = LINE;
        } else {
          pos = n;
          fend = END;
        }
        fp.push(esc ? JSON.stringify(fval) : '"' + fval + '"');
      }
      if (fend !== COMMA) break;
    }

    if (fp.length === 1 && fp[0] === '""' && !quoted) continue;

    if (width < 0) width = fp.length;
    if (header && !haveColumns) {
      haveColumns = true;
      colStr = '[' + fp.join(',') + ']';
      continue;
    }
    if (fp.length < width) {
      err('short_row', `"fields":${fp.length}`);
      while (fp.length < width) fp.push('""');
    } else if (fp.length > width) {
      const extra = fp.splice(width);
      err('long_row', `"extra":[${extra.join(',')}]`);
    }
    rowParts.push('[' + fp.join(',') + ']');
    rowCount += 1;
  }

  return '{"columns":' + (header ? (colStr === null ? '[]' : colStr) : 'null')
    + ',"rows":[' + rowParts.join(',') + '],"errors":[' + errParts.join(',') + ']}';
}
