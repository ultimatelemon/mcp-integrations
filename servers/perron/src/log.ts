import { pino } from 'pino';

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: 'perron' },
    redact: ['req.headers["ocp-apim-subscription-key"]', 'headers']
  });
}
