import { createHash } from "node:crypto";
import path from "node:path";
import PizZip from "pizzip";
import { renderMinutesDocx } from "../src/minutes/render.js";
import { MinutesSchema } from "../src/minutes/schema.js";

type EntryManifest = {
  entryName: string;
  order: number;
  isDir: boolean;
  uncompressedSize: number;
  compressedSize: number | null;
  crc32: number | null;
  sha256: string | null;
  timestamp: string | null;
};

const verbose = process.argv.includes("--verbose");
const envTemplate = process.env.DOCX_TEMPLATE_PATH?.trim();
const templatePath = envTemplate && envTemplate.length > 0
  ? envTemplate
  : path.resolve("minutes_template.docx");

const minutes = MinutesSchema.parse({
  title: "Weekly Sync",
  date: "2026-01-28",
  attendees: ["Alice", "Bob"],
  summary: ["Status reviewed", "Next steps agreed"],
  decisions: [{ text: "Ship v1", evidence: ["Consensus"] }],
  actions: [
    {
      task: "Prepare release notes",
      owner: "Alice",
      due: "2026-02-05",
      evidence: ["Decision log"]
    }
  ],
  open_questions: [{ text: "Need feature X?", evidence: ["Open item"] }]
});

const input = {
  minutes,
  trace: { transcriptId: "t1", transcriptEtag: "etag1", transcriptName: "Transcript.docx" }
};

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

function entryTimestamp(file: any): string | null {
  const d = file?.date ?? file?.options?.date ?? null;
  if (d instanceof Date) return d.toISOString();
  if (typeof d === "string") return d;
  return d ? String(d) : null;
}

function buildManifest(buf: Buffer) {
  const zip = new PizZip(buf);
  const names = Object.keys(zip.files);
  const entries: EntryManifest[] = [];

  for (let i = 0; i < names.length; i++) {
    const name = names[i];
    const file: any = zip.files[name];
    const isDir = !!file?.dir;
    let data: Uint8Array | null = null;
    if (!isDir) {
      try {
        data = file.asUint8Array();
      } catch {
        data = null;
      }
    }

    const compressedSize = file?._data?.compressedSize ?? null;
    const crc32 = file?._data?.crc32 ?? null;

    entries.push({
      entryName: name,
      order: i,
      isDir,
      uncompressedSize: data ? data.length : 0,
      compressedSize,
      crc32,
      sha256: data ? sha256(data) : null,
      timestamp: entryTimestamp(file)
    });
  }

  return { entries };
}

function diffManifests(a: EntryManifest[], b: EntryManifest[]) {
  const byNameA = new Map(a.map((e) => [e.entryName, e]));
  const byNameB = new Map(b.map((e) => [e.entryName, e]));
  const onlyA = a.filter((e) => !byNameB.has(e.entryName)).map((e) => e.entryName);
  const onlyB = b.filter((e) => !byNameA.has(e.entryName)).map((e) => e.entryName);

  const changed: Array<{ entryName: string; diffs: Record<string, { a: unknown; b: unknown }> }> = [];

  for (const eA of a) {
    const eB = byNameB.get(eA.entryName);
    if (!eB) continue;
    const diffs: Record<string, { a: unknown; b: unknown }> = {};
    if (eA.order !== eB.order) diffs.order = { a: eA.order, b: eB.order };
    if (eA.uncompressedSize !== eB.uncompressedSize) diffs.uncompressedSize = { a: eA.uncompressedSize, b: eB.uncompressedSize };
    if (eA.compressedSize !== eB.compressedSize) diffs.compressedSize = { a: eA.compressedSize, b: eB.compressedSize };
    if (eA.crc32 !== eB.crc32) diffs.crc32 = { a: eA.crc32, b: eB.crc32 };
    if (eA.sha256 !== eB.sha256) diffs.sha256 = { a: eA.sha256, b: eB.sha256 };
    if (eA.timestamp !== eB.timestamp) diffs.timestamp = { a: eA.timestamp, b: eB.timestamp };
    if (Object.keys(diffs).length > 0) {
      changed.push({ entryName: eA.entryName, diffs });
    }
  }

  return { onlyA, onlyB, changed };
}

const buf1 = renderMinutesDocx(templatePath, input);
const buf2 = renderMinutesDocx(templatePath, input);

const manifest1 = buildManifest(buf1);
const manifest2 = buildManifest(buf2);

if (verbose) {
  console.log("RUN1 manifest");
  console.log(JSON.stringify(manifest1.entries, null, 2));
  console.log("RUN2 manifest");
  console.log(JSON.stringify(manifest2.entries, null, 2));
}

const diff = diffManifests(manifest1.entries, manifest2.entries);
console.log("DIFF");
console.log(JSON.stringify(diff, null, 2));
