import { z } from 'zod';
import type { BillingDefaultsV1, OrgBillingConfigV1 } from './types.js';

export const BillingDefaultsV1Schema = z.object({
  billing_currency: z.string().min(1),
  markup_pct: z.number(),
  rate_card_name: z.string().min(1),
});

const OrgBillingConfigV1Schema = BillingDefaultsV1Schema.partial();

export function parseBillingDefaultsV1(value: string): BillingDefaultsV1 {
  const parsed = JSON.parse(value) as unknown;
  return BillingDefaultsV1Schema.parse(parsed);
}

export function resolveBillingConfigV1(
  input: {
    system_defaults: BillingDefaultsV1;
    org_billing_config: unknown;
  },
): BillingDefaultsV1 {
  const system = input.system_defaults;
  const orgConfig = OrgBillingConfigV1Schema.safeParse(input.org_billing_config);
  const org: OrgBillingConfigV1 = orgConfig.success ? orgConfig.data : {};

  return {
    billing_currency: org.billing_currency ?? system.billing_currency,
    markup_pct: org.markup_pct ?? system.markup_pct,
    rate_card_name: org.rate_card_name ?? system.rate_card_name,
  };
}

