import { InputError } from "./errors.ts";

/** The part of a zod schema this server uses. Structural, so the schemas in @bump/shared need no second zod copy here. */
type Schema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }> } };
};

/** Parses a request body or query; the first problem becomes a 400 naming the field. */
export function parse<T>(schema: Schema<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const issue = result.error.issues[0];
  const field = issue?.path.map(String).join(".");
  throw new InputError(field ? `${field}: ${issue?.message}` : (issue?.message ?? "Invalid request."));
}
