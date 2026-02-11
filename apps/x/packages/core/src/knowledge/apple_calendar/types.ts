import z from "zod";

// --- Config Schema ---

export const AppleCalendarConfig = z.object({
    enabled: z.boolean(),
});
export type AppleCalendarConfig = z.infer<typeof AppleCalendarConfig>;
