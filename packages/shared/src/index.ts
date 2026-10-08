import { z } from 'zod';

export const roles = ['OWNER', 'EMPLOYEE'] as const;
export type Role = (typeof roles)[number];

export const stages = ['RECEIVED', 'WASHING', 'READY', 'HANDED_OVER'] as const;
export type Stage = (typeof stages)[number];

export const stageLabels: Record<Stage, string> = {
  RECEIVED: 'Received',
  WASHING: 'Started Washing',
  READY: 'Ready',
  HANDED_OVER: 'Handover',
};

export function canMoveStage(from: Stage, to: Stage): boolean {
  const index = stages.indexOf(from);
  return index >= 0 && index < stages.length - 1 && stages[index + 1] === to;
}

export function normalizeIndianMobile(input: string): string {
  const digits = input.replace(/\D/g, '');
  const withoutTrunk = digits.startsWith('0') && (digits.length === 11 || digits.length === 13) ? digits.slice(1) : digits;
  const local = withoutTrunk.startsWith('91') && withoutTrunk.length === 12 ? withoutTrunk.slice(2) : withoutTrunk;
  if (!/^[6-9]\d{9}$/.test(local)) throw new Error('Enter a valid Indian mobile number');
  return `+91${local}`;
}

const indianMobileSchema = z.string().transform((value, context) => {
  try { return normalizeIndianMobile(value); }
  catch {
    context.addIssue({ code: 'custom', message: 'Enter a valid Indian mobile number' });
    return z.NEVER;
  }
});

export function normalizeRegistration(input: string): string {
  const value = input.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const standard = /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{1,4}$/;
  const bh = /^\d{2}BH\d{4}[A-Z]{1,2}$/;
  if (!standard.test(value) && !bh.test(value)) throw new Error('Enter a valid Indian registration number');
  return value;
}

const registrationSchema = z.string().transform((value, context) => {
  try { return normalizeRegistration(value); }
  catch {
    context.addIssue({ code: 'custom', message: 'Enter a valid Indian registration number' });
    return z.NEVER;
  }
});

export const ownerLoginSchema = z.object({
  login: z.string().trim().min(3).max(254),
  password: z.string().min(1).max(1024),
});

export const ownerSetupSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  password: z.string().min(14).max(128),
});

export const employeeSchema = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: indianMobileSchema,
  branchId: z.string().min(1).optional(),
  active: z.boolean().default(true),
});

export const employeeUpdateSchema = employeeSchema.partial();
const branchFields = {
  name: z.string().trim().min(2).max(120),
  code: z.string().trim().max(32).regex(/^[A-Za-z0-9_-]*$/).optional(),
  phone: z.string().trim().min(5).max(30),
  email: z.union([z.email().max(254), z.literal('')]).optional(),
  addressLine1: z.string().trim().min(3).max(200),
  addressLine2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(2).max(100),
  state: z.string().trim().min(2).max(100),
  postalCode: z.string().trim().min(3).max(20),
  country: z.string().trim().min(2).max(80),
  timezone: z.string().trim().min(1).max(80).refine((value) => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }, 'Enter a valid timezone'),
  openingTime: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal('')]).optional(),
  closingTime: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal('')]).optional(),
};
export const branchCreateSchema = z.object(branchFields).strict();
export const branchUpdateSchema = branchCreateSchema.partial();
export const otpRequestSchema = z.object({ mobile: indianMobileSchema });
export const otpVerifySchema = z.union([
  otpRequestSchema.extend({ code: z.string().regex(/^\d{6}$/) }),
  otpRequestSchema.extend({ accessToken: z.string().min(32).max(8192).regex(/^\S+$/) }),
]);

export const vehicleTypes = ['HATCHBACK', 'SEDAN', 'SUV', 'MUV', 'TWO_WHEELER', 'COMMERCIAL', 'OTHER'] as const;
export type VehicleType = (typeof vehicleTypes)[number];

const mobileSchema = indianMobileSchema;
export const customerSchema = z.object({
  name: z.string().trim().min(2).max(120),
  mobile: mobileSchema,
  alternateMobile: mobileSchema.optional(),
  email: z.email().max(254).optional(),
  notes: z.string().trim().max(2000).optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});
export const customerUpdateSchema = customerSchema.partial();

export const vehicleSchema = z.object({
  customerId: z.string().min(1),
  registrationNumber: registrationSchema,
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  variant: z.string().trim().max(80).optional(),
  type: z.enum(vehicleTypes),
  colour: z.string().trim().max(60).optional(),
  year: z.number().int().min(1950).max(2100).optional(),
  notes: z.string().trim().max(2000).optional(),
});
export const vehicleUpdateSchema = vehicleSchema.omit({ customerId: true, registrationNumber: true }).partial();

export const serviceSchema = z.object({
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(2000).optional(),
  category: z.string().trim().min(2).max(80),
  basePricePaise: z.number().int().min(0).max(100_000_000),
  estimatedMinutes: z.number().int().min(1).max(10080),
  taxRateBps: z.number().int().min(0).max(10000).default(0),
  active: z.boolean().default(true),
});
export const serviceUpdateSchema = serviceSchema.partial();
export const servicePriceSchema = z.object({
  branchId: z.string().optional(),
  vehicleType: z.enum(vehicleTypes),
  pricePaise: z.number().int().min(0).max(100_000_000),
});

export const paymentMethods = ['CASH', 'UPI', 'CARD', 'BANK_TRANSFER', 'OTHER'] as const;
export type PaymentMethod = (typeof paymentMethods)[number];
export const dailySummaryQuerySchema = z.object({ branchId: z.string().min(1).optional() });
export type DailySummary = {
  date: string;
  timeZone: string;
  asOf: string;
  branchId: string | null;
  receivedCount: number;
  activeCount: number;
  readyCount: number;
  handedOverCount: number;
  stillOnBoardCount: number;
  collectedPaise: number;
  collectionByMethod: { method: PaymentMethod; amountPaise: number }[];
  unpaidPaise: number;
  unpaidInvoiceCount: number;
  pipelinePaise: number;
  avgTurnaroundMinutes: number | null;
  lateCount: number;
  services: { name: string; count: number; valuePaise: number }[];
  hours: { hour: number; count: number }[];
  busiestHour: number | null;
  staff: { id: string; name: string; cars: number; updates: number; handovers: number }[];
  customers: { newCount: number; returningCount: number };
  attention: { kind: 'LATE' | 'READY_WAITING' | 'UNPAID'; jobId: string; registrationNumber: string; customerName: string; detail: string; amountPaise?: number }[];
};
export const messageEvents = ['VEHICLE_RECEIVED', 'WASH_STARTED', 'VEHICLE_READY', 'VEHICLE_HANDED_OVER'] as const;
export type MessageEvent = (typeof messageEvents)[number];

export const checkInSchema = z.object({
  idempotencyKey: z.uuid(),
  mobile: mobileSchema,
  customerName: z.string().trim().min(2).max(120),
  registrationNumber: registrationSchema,
  make: z.string().trim().min(1).max(80),
  model: z.string().trim().min(1).max(80),
  vehicleType: z.enum(vehicleTypes),
  serviceId: z.string().min(1),
  branchId: z.string().min(1).optional(),
  expectedAt: z.iso.datetime({ offset: true }),
  notes: z.string().trim().max(2000).optional(),
  employeeIds: z.array(z.string().min(1)).max(20).default([]),
  notify: z.boolean().default(true),
});

export const advanceStageSchema = z.object({ to: z.enum(['WASHING', 'READY']) });
export const stageCorrectionSchema = z.object({
  to: z.enum(['RECEIVED', 'WASHING', 'READY']),
  reason: z.string().trim().min(5).max(500),
});
export const handoverSchema = z.object({
  paymentAmountPaise: z.number().int().min(0).max(100_000_000).default(0),
  paymentMethod: z.enum(paymentMethods).optional(),
  paymentReference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
}).refine((value) => value.paymentAmountPaise === 0 || !!value.paymentMethod, { path: ['paymentMethod'], message: 'Payment method is required for a collected amount' });
export const paymentSchema = z.object({
  idempotencyKey: z.uuid(),
  amountPaise: z.number().int().positive().max(100_000_000),
  method: z.enum(paymentMethods),
  reference: z.string().trim().max(120).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export const saleItemSchema = z.object({
  kind: z.enum(['ADD_ON', 'PRODUCT']),
  name: z.string().trim().min(2).max(120),
  pricePaise: z.number().int().min(0).max(100_000_000),
  active: z.boolean().default(true),
});
export const invoiceSettingsSchema = z.object({
  gstRateBps: z.number().int().min(0).max(10000).nullable().optional(),
  gstin: z.string().trim().max(20).nullable().optional(),
  invoiceAddress: z.string().trim().max(500).nullable().optional(),
  invoicePhone: z.string().trim().max(30).nullable().optional(),
  allowCustomInvoiceItems: z.boolean().optional(),
  employeeAddons: z.boolean().optional(),
});
export const invoiceDraftSchema = z.object({
  items: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('ADD_ON'), saleItemId: z.string().min(1), quantity: z.number().int().min(1).max(100) }),
    z.object({ kind: z.literal('PRODUCT'), saleItemId: z.string().min(1), quantity: z.number().int().min(1).max(100) }),
    z.object({ kind: z.literal('CUSTOM'), description: z.string().trim().min(2).max(200), quantity: z.number().int().min(1).max(100), unitPricePaise: z.number().int().min(0).max(100_000_000) }),
  ])).max(40).default([]),
  discountKind: z.enum(['NONE', 'FLAT', 'PERCENT']).default('NONE'),
  discountValue: z.number().int().min(0).max(100_000_000).default(0),
});
export const operationSettingsSchema = z.object({
  allowOutstanding: z.boolean().optional(),
  employeeHandover: z.boolean().optional(),
  sendHandoverMessage: z.boolean().optional(),
  showCustomerTrackingLink: z.boolean().optional(),
  showCompletedVehiclePhotos: z.boolean().optional(),
});

export const photoKinds = ['BEFORE', 'DURING', 'AFTER', 'DAMAGE'] as const;
export const inspectionLocations = ['FRONT', 'REAR', 'LEFT', 'RIGHT', 'INTERIOR', 'WINDSHIELD', 'WHEELS', 'OTHER'] as const;
export const damageTypes = ['SCRATCH', 'DENT', 'CRACK', 'PAINT_DAMAGE', 'BROKEN_ITEM', 'INTERIOR_DAMAGE', 'OTHER'] as const;
export const inspectionSchema = z.object({
  damages: z.array(z.object({
    location: z.enum(inspectionLocations),
    type: z.enum(damageTypes),
    description: z.string().trim().max(1000).optional(),
  })).max(50),
});
