import { z } from "zod";

export const Operation = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    title: z.string(),
    start: z.string().describe("ISO 8601 local datetime, e.g. 2026-09-08T14:00"),
    end: z.string().describe("ISO 8601 local datetime"),
    category: z.enum(["school", "work", "personal", "other"]),
    location: z.string().nullable(),
    description: z.string().nullable(),
  }),
  z.object({
    type: z.literal("move"),
    event_id: z.string(),
    calendar_id: z.string(),
    new_start: z.string(),
    new_end: z.string(),
  }),
  z.object({
    type: z.literal("update"),
    event_id: z.string(),
    calendar_id: z.string(),
    title: z.string().nullable(),
    location: z.string().nullable(),
    description: z.string().nullable(),
  }),
  z.object({
    type: z.literal("delete"),
    event_id: z.string(),
    calendar_id: z.string(),
  }),
]);
export type Operation = z.infer<typeof Operation>;

export const WeeklyPlan = z.object({
  headline: z.string().describe("One sentence summarizing the week's load and balance."),
  observations: z.array(z.string()).describe("Up to 5 short, specific observations about the week (overloads, gaps, conflicts, missing breaks)."),
  proposals: z
    .array(
      z.object({
        title: z.string().describe("Short imperative title, e.g. 'Move study block to Tue afternoon'"),
        rationale: z.string().describe("One sentence on why this helps."),
        operations: z.array(Operation).describe("Concrete calendar operations that implement this proposal."),
      }),
    )
    .describe("0 to 6 proposals, most impactful first. Empty if the week already looks good."),
  questions: z.array(z.string()).describe("Up to 2 questions you need answered to plan better (e.g. a deadline you can't see)."),
});
export type WeeklyPlan = z.infer<typeof WeeklyPlan>;
