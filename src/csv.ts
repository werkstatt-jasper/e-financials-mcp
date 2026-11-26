/**
 * Parse a CSV document into records. Accepts LF or CRLF line endings.
 * Quoted fields may contain line breaks. A trailing newline does not add
 * an extra empty record.
 */
export function parseCsv(text: string, delimiter = ","): string[][] {
  const records: string[][] = [];
  let fields: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  let started = false;

  const endField = () => {
    fields.push(field);
    field = "";
  };

  const endRecord = () => {
    endField();
    records.push(fields);
    fields = [];
    started = false;
  };

  while (i < text.length) {
    const ch = text.charAt(i);
    started = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      endField();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") {
        i += 1;
      }
      endRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }

  if (started) {
    endRecord();
  }

  return records;
}
