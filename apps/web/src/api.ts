export type Session = { user: { id: string; role: 'OWNER' | 'EMPLOYEE'; name: string; organizationId: string; branchId: string | null }; organization: { id: string; name: string } };
export type Employee = { id: string; name: string; mobile: string; active: boolean; branchId: string | null; branchName: string | null; lastLoginAt: string | null };
export type Branch = { id: string; name: string; code?: string | null; address: string | null; phone: string | null; email?: string | null; addressLine1?: string | null; addressLine2?: string | null; city?: string | null; state?: string | null; postalCode?: string | null; country?: string; timezone?: string; openingTime?: string | null; closingTime?: string | null; active: boolean; employeeCount?: number; activeJobCount?: number; todayJobCount?: number };
export type Vehicle = { id: string; customerId: string; registrationNumber: string; make: string; model: string; type: string; colour: string | null; customer?: { id: string; name: string; mobile: string } };
export type Customer = { id: string; name: string; mobile: string; email: string | null; notes: string | null; tags: string[]; vehicles: Vehicle[] };
export type ServicePrice = { id: string; branchId: string | null; vehicleType: string; pricePaise: number };
export type Service = { id: string; name: string; category: string; description: string | null; basePricePaise: number; estimatedMinutes: number; active: boolean; prices: ServicePrice[]; branches: { branchId: string; active: boolean }[] };
export type JobStage = 'RECEIVED' | 'WASHING' | 'READY' | 'HANDED_OVER';
export type Job = {
  id: string; number: number; status: JobStage; serviceId: string; serviceName: string; branchId: string;
  checkedInAt: string; stageAt: string; expectedAt: string; handedOverAt: string | null;
  notes: string | null; handoverNotes: string | null; notify: boolean;
  customer: { id: string; name: string; mobile: string };
  vehicle: { id: string; registrationNumber: string; make: string; model: string; type: string };
  branch: { id: string; name: string };
  subtotalPaise?: number; taxPaise?: number; totalPaise?: number;
  paidPaise?: number; outstandingPaise?: number; paymentStatus?: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
  checkedInBy?: { id: string; name: string };
  handedOverBy?: { id: string; name: string } | null;
  stages?: { id: string; fromStage: JobStage | null; toStage: JobStage; note: string | null; createdAt: string; actor: { id: string; name: string } }[];
  assignments?: { id: string; removedAt: string | null; employee: { id: string; name: string } }[];
  messages?: { id: string; event: string; status: 'PENDING' | 'SENDING' | 'SENT' | 'FAILED'; createdAt: string; sentAt: string | null; failedAt: string | null; provider?: 'MOCK' | 'MSG91'; providerMessageId?: string | null; renderedText?: string; failureReason?: string | null; attempts?: number; deliveryAttempts?: { id: string; number: number; status: string; createdAt: string; failureReason: string | null }[] }[];
  invoice?: { id: string; invoiceNumber: string; totalPaise: number; status: string; issuedAt: string | null; items: InvoiceLine[]; discountKind: 'NONE' | 'FLAT' | 'PERCENT'; discountValue: number; discountPaise: number; subtotalPaise: number; taxablePaise: number; taxPaise: number; payments: { id: string; amountPaise: number; method: string; createdAt: string; collectedBy: { id: string; name: string } }[] } | null;
  selectedAddOns?: { description: string; quantity: number }[];
  inspection?: { id: string; finalizedAt: string; recordedBy: { id: string; name: string }; damages: { id: string; location: string; type: string; description: string | null }[] } | null;
  photos?: { id: string; kind: 'BEFORE' | 'DURING' | 'AFTER' | 'DAMAGE'; description: string | null; customerVisible: boolean; damageItemId: string | null; createdAt: string; uploadedBy: { id: string; name: string } }[];
};
export type BoardMetrics = { inBay: number; received: number; washing: number; ready: number; late: number; collectedPaise?: number };
export type OperationCapabilities = { allowOutstanding?: boolean; canHandover: boolean; canAddOns?: boolean };
export type OperationSettings = { allowOutstanding: boolean; employeeHandover: boolean; sendHandoverMessage: boolean; showCustomerTrackingLink: boolean; showCompletedVehiclePhotos: boolean };
export type SaleItem = { id: string; kind: 'ADD_ON' | 'PRODUCT'; name: string; pricePaise?: number; active: boolean };
export type InvoiceSettings = { gstRateBps: number | null; gstin: string | null; invoiceAddress: string | null; invoicePhone: string | null; allowCustomInvoiceItems: boolean; employeeAddons: boolean };
export type InvoiceLine = { id: string; kind: 'SERVICE' | 'ADD_ON' | 'PRODUCT' | 'CUSTOM'; saleItemId: string | null; description: string; quantity: number; unitPricePaise: number; subtotalPaise: number; taxRateBps: number; taxPaise: number; totalPaise: number };
export type CustomerInvoice = { id: string; jobId: string; invoiceNumber: string; status: 'DRAFT' | 'ISSUED' | 'PARTIALLY_PAID' | 'PAID' | 'CANCELLED'; createdAt: string; issuedAt: string | null; subtotalPaise: number; discountKind: 'NONE' | 'FLAT' | 'PERCENT'; discountValue: number; discountPaise: number; taxablePaise: number; taxPaise: number; totalPaise: number; paidPaise: number; outstandingPaise: number; items: InvoiceLine[]; payments: { id: string; amountPaise: number; method: string; reference: string | null; createdAt: string; collectedBy: { name: string } }[]; job: { number: number; serviceName: string; customer: { name: string; mobile: string }; vehicle: { registrationNumber: string; make: string; model: string }; branch: { name: string; address: string | null; phone: string | null } }; organization: { name: string; gstin: string | null; invoiceAddress: string | null; invoicePhone: string | null; currency: string } };
export type InvoiceListRow = Pick<CustomerInvoice, 'id' | 'invoiceNumber' | 'status' | 'createdAt' | 'issuedAt' | 'totalPaise' | 'paidPaise' | 'outstandingPaise'> & { job: { number: number; branch: { id: string; name: string }; customer: { name: string; mobile: string }; vehicle: { registrationNumber: string } } };
export type PaymentRow = { id: string; amountPaise: number; method: string; reference: string | null; createdAt: string; collectedBy: { name: string }; invoice: { id: string; invoiceNumber: string; job: { branch: { id: string; name: string }; vehicle: { registrationNumber: string } } } };
export type WhatsAppSettings = { provider: 'MOCK' | 'MSG91'; enabled: boolean; senderNumber: string | null; senderDisplayName: string | null; msg91IntegratedNumberId: string | null; templateReceived: string; templateWashing: string; templateReady: string; templateHandedOver: string | null; status: string; lastVerifiedAt: string | null; templateStatuses?: Record<string, string> };
export type TrackingStatus = { businessName: string; businessLogoUrl: string | null; vehicleRegistration: string; vehicleMake: string; vehicleModel: string; serviceName: string; status: JobStage; expectedCompletionAt: string; receivedAt: string; washingStartedAt: string | null; readyAt: string | null; handedOverAt: string | null; photos: { url: string }[] };
export type AvailableEmployee = { id: string; name: string; branchId: string | null };

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.message || 'Request failed');
  return body as T;
}

export const post = <T,>(path: string, body: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(body) });
export const patch = <T,>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });

export async function upload<T>(path: string, file: File): Promise<T> {
  const body = new FormData();
  body.append('file', file);
  const response = await fetch(`/api${path}`, { method: 'POST', credentials: 'include', body });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || 'Upload failed');
  return result as T;
}
