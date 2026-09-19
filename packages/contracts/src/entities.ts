import { z } from "zod";

export const EntityId = z.string().min(1).max(128);
export const IsoDateTime = z.string().datetime({ offset: true });
export const CurrencyCode = z.string().length(3).toUpperCase();
export const MinorUnits = z.number().int().nonnegative();

export const CustomerSchema = z.object({
  id: EntityId,
  name: z.string().min(1),
  segment: z.enum(["startup", "mid_market", "enterprise"]),
  timezone: z.string().min(1)
});

export const SubscriptionSchema = z.object({
  id: EntityId,
  customerId: EntityId,
  status: z.enum(["trialing", "active", "past_due", "cancelled"]),
  term: z.enum(["monthly", "annual"]),
  arrMinor: MinorUnits,
  currency: CurrencyCode,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime.nullable()
});

export const TimeWindowSchema = z.object({
  start: IsoDateTime,
  end: IsoDateTime,
  timezone: z.string().min(1),
  grain: z.enum(["minute", "hour", "day", "week", "month"])
}).refine((value) => value.start < value.end, { message: "start must precede end" });

export const EntityRefSchema = z.object({
  type: z.enum(["customer", "subscription", "release", "incident", "ticket", "feature", "service"]),
  id: EntityId,
  label: z.string().optional()
});

export type Customer = z.infer<typeof CustomerSchema>;
export type Subscription = z.infer<typeof SubscriptionSchema>;
export type TimeWindow = z.infer<typeof TimeWindowSchema>;
export type EntityRef = z.infer<typeof EntityRefSchema>;
