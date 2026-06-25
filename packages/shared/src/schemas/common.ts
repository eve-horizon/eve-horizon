import { z, type ZodTypeAny } from 'zod';

export const PaginationSchema = z.object({
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
});

export type Pagination = z.infer<typeof PaginationSchema>;

export const ApiListPaginationSchema = z.object({
  total: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative(),
  has_more: z.boolean().optional(),
  next_offset: z.number().int().nonnegative().nullable().optional(),
});

export type ApiListPagination = z.infer<typeof ApiListPaginationSchema>;

export const createApiListResponseSchema = <T extends ZodTypeAny>(itemSchema: T) => z.object({
  data: z.array(itemSchema),
  pagination: ApiListPaginationSchema.optional(),
});

export const createApiSingleResponseSchema = <T extends ZodTypeAny>(itemSchema: T) => z.object({
  data: itemSchema,
});

export type ApiListResponse<T> = {
  data: T[];
  pagination?: ApiListPagination;
};

export type ApiSingleResponse<T> = {
  data: T;
};

/**
 * Git SHA validation schema - requires exactly 40 lowercase hex characters.
 * Rejects branch names and short SHAs to ensure data integrity.
 */
export const GitShaSchema = z
  .string()
  .length(40, 'git_sha must be exactly 40 characters')
  .regex(/^[a-f0-9]{40}$/, {
    message:
      'git_sha must be a 40-character lowercase hex SHA. Did you pass a branch name or uppercase SHA? Use the CLI to resolve refs automatically.',
  });
