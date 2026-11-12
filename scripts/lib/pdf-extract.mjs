// Shared by the browser E2E scripts: parse a downloaded report PDF, extract its text and attached JSON, and assert that
// the JSON printed in the text equals the attached JSON.
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const strip = (s) => s.replace(/\s+/g, "");
const BEGIN = "=== BEGIN STRUCTURED DATA (JSON, schema fpl-gw-report/1) ===";
const END = "=== END STRUCTURED DATA ===";

export async function readPdf(file) {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(0, 5).toString(), "%PDF-", "downloaded file is a PDF");
  const doc = await getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const t = await (await doc.getPage(i)).getTextContent();
    text += t.items.map((it) => it.str + (it.hasEOL ? "\n" : " ")).join("") + "\n";
  }
  const m = buf.indexOf("/Type /EmbeddedFile");
  assert.ok(m > 0, "PDF carries an embedded JSON file");
  const dict = buf.subarray(buf.lastIndexOf("obj", m), buf.indexOf("stream", m)).toString("latin1");
  let from = buf.indexOf("stream", m) + 6;
  if (buf[from] === 0x0d) from++;
  if (buf[from] === 0x0a) from++;
  let data = buf.subarray(from, buf.indexOf("endstream", from));
  if (/FlateDecode/.test(dict)) data = inflateSync(data);
  const json = JSON.parse(data.toString("utf8"));
  const meta = await doc.getMetadata();
  const flat = strip(text);
  const a = flat.indexOf(strip(BEGIN));
  const b = flat.lastIndexOf(strip(END));
  const printed = flat.slice(a + strip(BEGIN).length, b).replace(/FPLIntelligencereport\|GW\d+\|page\d+\/\d+/g, "");
  assert.equal(printed, strip(JSON.stringify(json)), "text JSON equals attached JSON");
  return { text, json, pages: doc.numPages, title: meta.info.Title, size: buf.length };
}
