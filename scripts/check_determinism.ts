import { createHash } from "node:crypto";
import path from "node:path";
import { renderMinutesDocx } from "../src/minutes/render.js";
import { MinutesSchema } from "../src/minutes/schema.js";

const templatePath = path.resolve("templates/minutes_template.docx");

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

const buf1 = renderMinutesDocx(templatePath, input);
const buf2 = renderMinutesDocx(templatePath, input);

const h1 = createHash("sha256").update(buf1).digest("hex");
const h2 = createHash("sha256").update(buf2).digest("hex");

if (h1 !== h2) {
  console.error("Non-deterministic DOCX output", { h1, h2 });
  process.exit(1);
}

console.log("DOCX determinism OK", { hash: h1 });
