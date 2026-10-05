import type { DiscountKind, InvoiceItemKind } from './generated/prisma/client.js';

export type PriceLine = { kind: InvoiceItemKind; description: string; quantity: number; unitPricePaise: number; taxRateBps: number; saleItemId?: string };

export function calculateInvoice(lines: PriceLine[], discountKind: DiscountKind, discountValue: number) {
  if (!lines.length) throw new Error('Invoice needs at least one line item');
  if (lines.some((line) => !Number.isInteger(line.quantity) || !Number.isInteger(line.unitPricePaise) || line.quantity <= 0 || line.unitPricePaise < 0 || line.quantity * line.unitPricePaise > 1_000_000_000)) throw new Error('Invoice line amount is out of range');
  const subtotalPaise = lines.reduce((sum, line) => sum + line.quantity * line.unitPricePaise, 0);
  if (subtotalPaise > 1_000_000_000) throw new Error('Invoice amount is out of range');
  if (discountKind === 'NONE') discountValue = 0;
  const discountPaise = discountKind === 'FLAT' ? discountValue : discountKind === 'PERCENT' ? Math.round(subtotalPaise * discountValue / 10_000) : 0;
  if (discountKind === 'PERCENT' && discountValue > 10_000) throw new Error('Discount cannot exceed 100%');
  if (discountPaise > subtotalPaise) throw new Error('Discount cannot exceed subtotal');
  const taxablePaise = subtotalPaise - discountPaise;
  let remainingDiscount = discountPaise;
  let remainingSubtotal = subtotalPaise;
  const items = lines.map((line, index) => {
    const lineSubtotal = line.quantity * line.unitPricePaise;
    const share = index === lines.length - 1 ? remainingDiscount : remainingSubtotal ? Math.min(lineSubtotal, Math.round(remainingDiscount * lineSubtotal / remainingSubtotal)) : 0;
    remainingDiscount -= share;
    remainingSubtotal -= lineSubtotal;
    const taxPaise = Math.round((lineSubtotal - share) * line.taxRateBps / 10_000);
    return { ...line, subtotalPaise: lineSubtotal, taxPaise, totalPaise: lineSubtotal - share + taxPaise };
  });
  const taxPaise = items.reduce((sum, line) => sum + line.taxPaise, 0);
  if (taxablePaise + taxPaise > 1_000_000_000) throw new Error('Invoice amount is out of range');
  return { items, subtotalPaise, discountKind, discountValue, discountPaise, taxablePaise, taxPaise, totalPaise: taxablePaise + taxPaise };
}
