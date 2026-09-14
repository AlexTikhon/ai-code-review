import { z } from "zod";
export const findingCategorySchema = z.enum([
  "correctness",
  "security",
  "performance",
  "type-safety",
  "error-handling",
  "maintainability",
]);
export const findingConfidenceSchema = z.enum(["low", "medium", "high"]);
export const rawEvidenceSchema = z
  .object({
    path: z.string().min(1),
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
    contextId: z.string().min(1).nullable().optional(),
  })
  .refine(
    (value) => value.endLine >= value.startLine,
    "endLine must be at least startLine",
  );
export const rawFindingSchema = z.object({
  severity: z.enum(["high", "medium", "low"]),
  category: findingCategorySchema,
  confidence: findingConfidenceSchema,
  title: z.string().min(1).max(200),
  explanation: z.string().min(1).max(2000),
  evidence: z.array(rawEvidenceSchema).min(1).max(5),
  suggestion: z.string().max(2000).nullable().optional(),
});
export const reviewResponseSchema = z
  .object({
    findings: z.array(rawFindingSchema).max(25),
    summary: z.string().max(2000),
    abstained: z.boolean(),
    abstentionReason: z.string().max(500).nullable().optional(),
  })
  .refine(
    (value) => !value.abstained || value.findings.length === 0,
    "An abstention cannot include findings",
  );
export type ReviewResponse = z.infer<typeof reviewResponseSchema>;

export const OPENAI_REVIEW_JSON_SCHEMA = {
  name: "code_review",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["findings", "summary", "abstained", "abstentionReason"],
    properties: {
      findings: {
        type: "array",
        maxItems: 25,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "severity",
            "category",
            "confidence",
            "title",
            "explanation",
            "evidence",
            "suggestion",
          ],
          properties: {
            severity: { enum: ["high", "medium", "low"] },
            category: {
              enum: [
                "correctness",
                "security",
                "performance",
                "type-safety",
                "error-handling",
                "maintainability",
              ],
            },
            confidence: { enum: ["low", "medium", "high"] },
            title: { type: "string" },
            explanation: { type: "string" },
            evidence: {
              type: "array",
              minItems: 1,
              maxItems: 5,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["path", "startLine", "endLine", "contextId"],
                properties: {
                  path: { type: "string" },
                  startLine: { type: "integer" },
                  endLine: { type: "integer" },
                  contextId: { type: ["string", "null"] },
                },
              },
            },
            suggestion: { type: ["string", "null"] },
          },
        },
      },
      summary: { type: "string" },
      abstained: { type: "boolean" },
      abstentionReason: { type: ["string", "null"] },
    },
  },
} as const;
