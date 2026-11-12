import { inflateSync } from "node:zlib";
import { JSON_BEGIN, JSON_END } from "@/lib/report/pdf";

export async function pdfInfo(buf: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(buf), useSystemFonts: false, verbosity: 0 }).promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const t = await (await doc.getPage(i)).getTextContent();
    pages.push(t.items.map((it: any) => it.str + (it.hasEOL ? "\n" : " ")).join(""));
  }
  const meta: any = await doc.getMetadata();
  const att = await doc.getAttachments();
  return { numPages: doc.numPages, pages, text: pages.join("\n"), title: meta.info?.Title as string, subject: meta.info?.Subject as string, attachmentNames: att ? [...(att as Map<string, any>).keys()] : [] };
}

/** Independent extraction of the embedded JSON file (inflates the /EmbeddedFile stream directly). */
export function embeddedJson(buf: Buffer): any {
  const marker = buf.indexOf("/Type /EmbeddedFile");
  if (marker < 0) throw new Error("no embedded file in PDF");
  const dictStart = buf.lastIndexOf("obj", marker);
  const streamStart = buf.indexOf("stream", marker);
  const dict = buf.subarray(dictStart, streamStart).toString("latin1");
  let from = streamStart + "stream".length;
  if (buf[from] === 0x0d) from++;
  if (buf[from] === 0x0a) from++;
  const end = buf.indexOf("endstream", from);
  let data = buf.subarray(from, end);
  if (/FlateDecode/.test(dict)) data = inflateSync(data.subarray(0, data.length));
  return JSON.parse(data.toString("utf8"));
}

const strip = (s: string) => s.replace(/\s+/g, "");

/** The JSON printed as text in the PDF, with page footers and all layout whitespace removed. */
export function textJson(text: string): string {
  const flat = strip(text);
  const begin = strip(JSON_BEGIN);
  const end = strip(JSON_END);
  const a = flat.indexOf(begin);
  const b = flat.lastIndexOf(end);
  if (a < 0 || b < 0) throw new Error("structured data markers missing");
  return flat.slice(a + begin.length, b).replace(/FPLIntelligencereport\|GW\d+\|page\d+\/\d+/g, "");
}
export const compact = (o: unknown) => strip(JSON.stringify(o));
