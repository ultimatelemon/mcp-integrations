/** Splits one CSV line (RFC 4180 quoting). GTFS fields never span lines, so a line is a record. */
export function parseCsvLine(line: string): string[] {
  if (!line.includes('"')) return line.split(',');
  const fields: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      fields.push(field);
      field = '';
    } else field += c;
  }
  fields.push(field);
  return fields;
}

/** Column positions from a header line, without the byte-order mark some feeds start with. */
export function columns(header: string): Map<string, number> {
  return new Map(
    parseCsvLine(header.replace(/^﻿/, '').trim()).map((name, i) => [
      name.trim(),
      i
    ])
  );
}

/** `25:10:00` → seconds after the service day's start; GTFS times run past 24:00. */
export function gtfsSeconds(value: string | undefined): number | undefined {
  const match = /^\s*(\d+):(\d{2}):(\d{2})\s*$/.exec(value ?? '');
  if (!match) return undefined;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}
