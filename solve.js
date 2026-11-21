// A fast drop-in for csv-reader 1.0.0: run(input) returns exactly the answer
// csv-reader gives for {text, header} — {columns, rows, errors} — only
// faster. Written from the documented reading policy, not from any other
// reader's code.
//
// Policy, as implemented here:
//   - a U+FEFF at the very start of the text is dropped;
//   - a record ends at LF or CRLF; a line left with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (error stray_cr);
//   - a field that opens with a quote runs to the next quote that is not
//     doubled; "" inside it is one quote, and each CRLF or lone CR inside it
//     is read as LF; what follows its closing quote, up to the next comma or
//     line break, is appended as it stands (quote_junk, when the field ends);
//     a quote that never closes is a literal character, and the text after it
//     is read again as unquoted (unterminated_quote);
//   - a quote inside an unquoted field is a literal character;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds
//     the records after it, each padded with "" (short_row, with fields: its
//     field count) or cut (long_row, with extra: the cut fields) to the first
//     record's width;
//   - each error is {code, line, row}, in the order met: line the 1-based line
//     its record starts on (every LF, CRLF and lone CR inside quotes counted),
//     row its record's index in rows (null for the header).
//
// Speed: most records hold no quote at all, so they are taken whole — one
// slice plus String.split(',') — instead of being walked character by
// character. Records that hold a quote are read field by field, but the
// unquoted-field scan is inlined straight into the record loop: one segment
// per field, found with indexOf and sliced out in one piece, no function call
// and no result array per field. No regular expressions, no per-character
// concatenation on the hot path. Pure: no clock, no randomness, no locale,
// nothing kept from one call to the next.

const COMMA = 0; // a field ended at a comma: the record goes on
const LINE = 1; // a field ended at a line break: the record ends
const END = 2; // a field ended at the end of the text: the record ends

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
    const q = text.indexOf('"', pos);
    if (q === -1 || q >= nlPos) {
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
    const fields = [];
    let quoted = false;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        quoted = true;
        readQuoted();
      } else {
        quoted = false;
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
