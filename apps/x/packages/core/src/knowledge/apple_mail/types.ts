import z from "zod";

// --- Config Schema ---

export const AppleMailConfig = z.object({
    enabled: z.boolean(),
});
export type AppleMailConfig = z.infer<typeof AppleMailConfig>;
