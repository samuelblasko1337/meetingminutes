// FILE: src/minutes/schema.ts
import { z } from "zod";

function unwrapMcpString(s: string): string {
  let t = s.trim();
  const wrapPairs: Array<[string, string]> = [
    ["`", "`"],
    ['"', '"'],
    ["'", "'"]
  ];
  for (const [l, r] of wrapPairs) {
    if (t.length >= 2 && t.startsWith(l) && t.endsWith(r)) {
      t = t.slice(1, -1).trim();
      break;
    }
  }
  return t;
}

const JsonStringToObject = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (typeof v !== "string") return v;
    const s = unwrapMcpString(v);
    try {
      return JSON.parse(s);
    } catch {
      return v; // will fail schema validation normally
    }
  }, schema);

export const LIMITS = {
  attendeesMax: 60,
  attendeeLenMax: 80,

  summaryMax: 10,
  summaryItemLenMax: 300,

  decisionTextLenMax: 500,
  actionTaskLenMax: 500,
  actionOwnerLenMax: 80,
  openQuestionTextLenMax: 500,

  evidenceItemLenMax: 300
} as const;

const DateYYYYMMDD = z.preprocess(
  (v) => (typeof v === "string" ? unwrapMcpString(v) : v),
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD")
);

// Some MCP clients serialize JSON null as the literal string "null".
const NullishStringToNull = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => {
    if (v == null) return null;
    if (typeof v === "string") {
      const s = unwrapMcpString(v).toLowerCase();
      if (s === "" || s === "null") return null;
      return unwrapMcpString(v);
    }
    return v;
  }, schema);

const EvidenceArray = z
  .array(z.string().min(1).max(LIMITS.evidenceItemLenMax))
  .min(1, "evidence must be non-empty");

export const MinutesSchema = z
  .object({
    title: z.string().min(1).max(140),
    date: DateYYYYMMDD,
    attendees: z.array(z.string().min(1).max(LIMITS.attendeeLenMax)).max(LIMITS.attendeesMax),
    summary: z.array(z.string().min(1).max(LIMITS.summaryItemLenMax)).max(LIMITS.summaryMax),

    decisions: z.array(
      z.object({
        text: z.string().min(1).max(LIMITS.decisionTextLenMax),
        evidence: EvidenceArray
      })
    ),

    actions: z.array(
      z.object({
        task: z.string().min(1).max(LIMITS.actionTaskLenMax),
        owner: z.string().min(1).max(LIMITS.actionOwnerLenMax),
        due: NullishStringToNull(DateYYYYMMDD.nullable()),
        evidence: EvidenceArray
      })
    ),

    open_questions: z.array(
      z.object({
        text: z.string().min(1).max(LIMITS.openQuestionTextLenMax),
        evidence: EvidenceArray
      })
    )
  })
  .strict();

export const Tool3InputSchema = z
  .object({
    source: JsonStringToObject(
      z.object({
        transcriptId: z.string().min(1),
        transcriptEtag: z.string().min(1),
        transcriptName: z.string().min(1)
      }).strict()
    ),
    minutes: JsonStringToObject(MinutesSchema),
    output: JsonStringToObject(
      z.object({
        fileName: NullishStringToNull(z.string().min(1).max(200).nullable()).optional()
      }).strict()
    )
  })
  .strict();

export type Minutes = z.infer<typeof MinutesSchema>;
export type Tool3Input = z.infer<typeof Tool3InputSchema>;
