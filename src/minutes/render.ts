// FILE: src/minutes/render.ts
import fs from "node:fs";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import type { Minutes } from "./schema.js";

export type RenderInput = {
  minutes: Minutes;
  trace?: string | Record<string, unknown> | null;
};

function dueDisplay(due: string | null): string {
  return due ? due : "—";
}

function stableStringify(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj).sort(([a], [b]) => a.localeCompare(b));
  const normalized: Record<string, unknown> = {};
  for (const [k, v] of entries) normalized[k] = v;
  return JSON.stringify(normalized);
}

function formatTrace(trace?: string | Record<string, unknown> | null): string {
  if (!trace) return "";
  if (typeof trace === "string") return trace;
  const t = trace as Record<string, unknown>;
  const tid = typeof t.transcriptId === "string" ? t.transcriptId : null;
  const etag = typeof t.transcriptEtag === "string" ? t.transcriptEtag : null;
  const name = typeof t.transcriptName === "string" ? t.transcriptName : null;
  if (tid || etag || name) {
    return `source=${tid ?? ""} etag=${etag ?? ""} name=${name ?? ""}`.trim();
  }
  return stableStringify(t);
}

export function renderMinutesDocx(templatePath: string, input: RenderInput): Buffer {
  const templateBuf = fs.readFileSync(templatePath);

  // Deterministic: no timestamps injected; zip is derived from the template + stable XML changes
  const zip = new PizZip(templateBuf);
  const doc = new Docxtemplater(zip, {
    paragraphLoop: true,
    linebreaks: true
  });

  const data = {
    title: input.minutes.title,
    date: input.minutes.date,
    attendees: input.minutes.attendees,
    summary: input.minutes.summary,
    decisions: input.minutes.decisions.map((d) => ({
      text: d.text,
      evidence: d.evidence
    })),
    actions: input.minutes.actions.map((a) => ({
      task: a.task,
      owner: a.owner,
      due: a.due,
      dueDisplay: dueDisplay(a.due),
      evidence: a.evidence
    })),
    open_questions: input.minutes.open_questions.map((q) => ({
      text: q.text,
      evidence: q.evidence
    })),
    trace: formatTrace(input.trace)
  };

  doc.render(data);

  const outZip = doc.getZip();
  const fixedDate = new Date(Date.UTC(1980, 0, 1, 0, 0, 0));

  const orderedNames = Object.keys(outZip.files).sort();
  const stableZip = new PizZip();
  for (const name of orderedNames) {
    const file: any = outZip.files[name];
    if (file?.dir) {
      stableZip.file(name, "", { dir: true, date: fixedDate });
    } else {
      const data = file.asUint8Array();
      stableZip.file(name, data, { date: fixedDate });
    }
  }

  return stableZip.generate({ type: "nodebuffer", compression: "DEFLATE" }) as Buffer;
}
