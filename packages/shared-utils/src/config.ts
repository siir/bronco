import { config as loadDotenv } from 'dotenv';
import type { ZodSchema } from 'zod';

loadDotenv();

export function loadConfig<T>(schema: ZodSchema<T>): T {
  const result = schema.safeParse(process.env);
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  ${i.path.join('.')}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid configuration:\n${formatted}`);
  }
  return result.data;
}
