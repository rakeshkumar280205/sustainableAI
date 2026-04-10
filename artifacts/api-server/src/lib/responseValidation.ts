import type { Response } from "express";
import { z, type ZodTypeAny } from "zod";
import { logger } from "./logger.js";

const internalServerErrorEnvelope = {
    success: false,
    data: null,
    error: {
        message: "Internal server error",
    },
};

export const ErrorEnvelopeSchema = z.object({
    success: z.literal(false),
    data: z.unknown().nullable().optional(),
    error: z.object({
        message: z.string(),
        details: z.string().optional(),
    }),
});

export function validateResponse<TSchema extends ZodTypeAny>(
    schema: TSchema,
    payload: unknown,
    context: string,
    requestId?: string,
): z.infer<TSchema> | null {
    const result = schema.safeParse(payload);
    if (!result.success) {
        logger.error(
            { requestId, context, issues: result.error.issues, payload },
            "Response validation failed",
        );
        return null;
    }

    return result.data;
}

export function sendValidatedResponse<TSchema extends ZodTypeAny>(
    res: Response,
    statusCode: number,
    schema: TSchema,
    payload: unknown,
    context: string,
    requestId?: string,
): boolean {
    const validated = validateResponse(schema, payload, context, requestId);
    if (!validated) {
        res.status(500).json(internalServerErrorEnvelope);
        return false;
    }

    res.status(statusCode).json(validated);
    return true;
}
