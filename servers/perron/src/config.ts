import { z } from 'zod';

const schema = z.object({
  NS_API_KEY: z.string().min(1, 'NS_API_KEY is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  HOST: z.string().default('0.0.0.0'),
  BASE_PATH: z.string().default(''),
  REDIS_URL: z
    .string()
    .optional()
    .transform((value) => value || undefined),
  ICON_URL: z
    .string()
    .optional()
    .transform((value) => value || undefined)
    .pipe(z.url().optional()),
  VEHICLES_CACHE_SECONDS: z.coerce.number().int().min(15).max(600).default(60),
  DATA_DIR: z.string().default('./data'),
  OV_AGENCY: z.string().min(1).default('GVB'),
  OV_LINES: z
    .string()
    .default('')
    .transform((value) =>
      value
        .split(',')
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  GTFS_URL: z.url().default('https://gtfs.ovapi.nl/nl/gtfs-nl.zip'),
  GTFS_RT_URL: z.url().default('https://gtfs.ovapi.nl/nl/tripUpdates.pb'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info')
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(env);
  if (!result.success) {
    const problems = result.error.issues
      .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  return result.data;
}
