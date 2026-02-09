// FILE: src/minutes/render.ts
import fs from "node:fs";
import Docxtemplater from "docxtemplater";
import PizZip from "pizzip";
import type { Minutes } from "./schema.js";

export type RenderInput = {
  minutes: Minutes;
  trace: {
    transcriptId: string;
    transcriptEtag: string;
    transcriptName: string;
  };
};

function dueDisplay(due: string | null): string {
  return due ? due : "—";
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
    trace: `source=${input.trace.transcriptId} etag=${input.trace.transcriptEtag} name=${input.trace.transcriptName}`
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
