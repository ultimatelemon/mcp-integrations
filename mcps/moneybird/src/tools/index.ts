import type { ToolDefinition } from './common.ts';
import { apiTools } from './api.ts';
import { assetsTools } from './assets.ts';
import { bankingTools } from './banking.ts';
import { coreTools } from './core.ts';
import { invoicingTools } from './invoicing.ts';
import { purchasesTools } from './purchases.ts';
import { reportsTools } from './reports.ts';
import { tasksTools } from './tasks.ts';
import { timeTools } from './time.ts';
import { webhooksTools } from './webhooks.ts';

/** Every tool this server knows about; the registry filters by toolset and permission. */
export const allTools: readonly ToolDefinition[] = [
  ...apiTools,
  ...coreTools,
  ...invoicingTools,
  ...purchasesTools,
  ...bankingTools,
  ...timeTools,
  ...reportsTools,
  ...assetsTools,
  ...tasksTools,
  ...webhooksTools
];

export * from './common.ts';
export * from './registry.ts';
