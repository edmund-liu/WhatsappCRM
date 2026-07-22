// Minimal, dependency-free .xlsx reader.
//
// An .xlsx file is a ZIP archive of XML parts. We read the ZIP central
// directory, inflate the parts we need (shared strings + the first
// worksheet), and extract the cell grid. Only what's needed to import a
// contact list — no styling, formulas, or multi-sheet resolution.
import zlib from 'zlib';

// ---- ZIP: read central directory and return a map of name -> Buffer ----
function unzip(buffer) {
  const files = new Map();
  // End of Central Directory record: signature 0x06054b50, search from the end.
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i >= buffer.length - 22 - 65536; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .xlsx file (no ZIP end record)');
  const entryCount = buffer.readUInt16LE(eocd + 10);
  let p = buffer.readUInt32LE(eocd + 16); // offset of central directory

  for (let n = 0; n < entryCount; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) break; // central dir header
    const method = buffer.readUInt16LE(p + 10);
    const compSize = buffer.readUInt32LE(p + 20);
    const nameLen = buffer.readUInt16LE(p + 28);
    const extraLen = buffer.readUInt16LE(p + 30);
    const commentLen = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen);

    // Jump to the local file header to find where the data actually begins.
    const lNameLen = buffer.readUInt16LE(localOffset + 26);
    const lExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compSize);
    files.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const decodeEntities = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
  .replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
  .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
  .replace(/&amp;/g, '&');

// Concatenate all <t> runs inside a shared-string <si> element.
function sharedStrings(xml) {
  if (!xml) return [];
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => {
    const parts = [...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1]));
    return parts.join('');
  });
}

// Excel column letters ("A", "AB") -> zero-based index.
function colIndex(ref) {
  const letters = ref.replace(/\d+/g, '');
  let idx = 0;
  for (const ch of letters) idx = idx * 26 + (ch.charCodeAt(0) - 64);
  return idx - 1;
}

// Parse the first worksheet into a 2-D array of trimmed cell strings.
export function readXlsx(buffer) {
  const files = unzip(buffer);
  const get = (name) => { const b = files.get(name); return b ? b.toString('utf8') : null; };
  const strings = sharedStrings(get('xl/sharedStrings.xml'));

  // Prefer sheet1.xml; otherwise take the first worksheet part present.
  let sheetXml = get('xl/worksheets/sheet1.xml');
  if (!sheetXml) {
    const key = [...files.keys()].find((k) => /^xl\/worksheets\/.*\.xml$/.test(k));
    sheetXml = key ? files.get(key).toString('utf8') : null;
  }
  if (!sheetXml) throw new Error('No worksheet found in the .xlsx file');

  const rows = [];
  for (const rowM of sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cM of rowM[1].matchAll(/<c\s+([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cM[1];
      const inner = cM[2] || '';
      const ref = (attrs.match(/r="([^"]+)"/) || [])[1] || '';
      const type = (attrs.match(/t="([^"]+)"/) || [])[1] || 'n';
      let value = '';
      if (type === 's') {
        const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = vi != null ? (strings[parseInt(vi, 10)] || '') : '';
      } else if (type === 'inlineStr') {
        value = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeEntities(t[1])).join('');
      } else {
        const vi = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        value = vi != null ? decodeEntities(vi) : '';
      }
      const idx = ref ? colIndex(ref) : cells.length;
      cells[idx] = String(value).trim();
    }
    for (let i = 0; i < cells.length; i++) if (cells[i] == null) cells[i] = '';
    rows.push(cells);
  }
  return rows;
}
