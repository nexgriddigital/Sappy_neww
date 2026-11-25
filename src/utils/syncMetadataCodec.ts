export interface EncodedSaleReturnMeta {
  r: boolean;
  at?: string;
  reason?: string;
  method?: string;
  by?: string;
}

const SALE_RETURN_MARKER_REGEX = /\s*<!--SAPPY_RET:([\s\S]*?)-->/g;
const CUSTOMER_UPDATED_MARKER_REGEX = /\s*<!--SAPPY_UPD:([\s\S]*?)-->/g;

export function stripSaleReturnMarker(notes?: string | null): string | undefined {
  if (!notes || typeof notes !== 'string') return undefined;
  const cleaned = notes.replace(SALE_RETURN_MARKER_REGEX, '').trim();
  return cleaned || undefined;
}

export function stripCustomerUpdatedMarker(notes?: string | null): string | undefined {
  if (!notes || typeof notes !== 'string') return undefined;
  const cleaned = notes.replace(CUSTOMER_UPDATED_MARKER_REGEX, '').trim();
  return cleaned || undefined;
}

export function encodeSaleNotesWithReturnMetadata(sale: {
  notes?: string | null;
  isReturned?: boolean;
  status?: string;
  returnedAt?: string;
  returnReason?: string;
  refundMethod?: string;
  returnedBy?: string;
}): string | null {
  const baseNotes = stripSaleReturnMarker(sale.notes);
  const isReturned = Boolean(sale.isReturned || sale.status === 'returned');

  if (!isReturned) {
    return baseNotes || null;
  }

  const meta: EncodedSaleReturnMeta = {
    r: true,
    ...(sale.returnedAt ? { at: sale.returnedAt } : {}),
    ...(sale.returnReason ? { reason: sale.returnReason } : {}),
    ...(sale.refundMethod ? { method: sale.refundMethod } : {}),
    ...(sale.returnedBy ? { by: sale.returnedBy } : {}),
  };

  const marker = `<!--SAPPY_RET:${JSON.stringify(meta)}-->`;
  return baseNotes ? `${baseNotes}\n${marker}` : marker;
}

export function decodeSaleFromRemoteRow(s: any): any {
  const rawNotes = typeof s?.notes === 'string' ? s.notes : '';
  let parsedMeta: EncodedSaleReturnMeta | null = null;

  const matches = [...rawNotes.matchAll(SALE_RETURN_MARKER_REGEX)];
  if (matches.length > 0) {
    const lastMatch = matches[matches.length - 1];
    try {
      const parsed = JSON.parse(lastMatch[1]);
      if (parsed && parsed.r) {
        parsedMeta = parsed;
      }
    } catch {
      // Ignore malformed marker
    }
  }

  const cleanNotes = stripSaleReturnMarker(rawNotes);
  const explicitReturned = Boolean(s?.is_returned ?? s?.isReturned ?? (s?.status === 'returned'));
  const isReturned = explicitReturned || Boolean(parsedMeta?.r);

  return {
    id: s.id,
    invoiceNumber: s.invoice_number ?? s.invoiceNumber,
    timestamp: s.timestamp || new Date().toISOString(),
    customerId: (s.customer_id ?? s.customerId) || undefined,
    customerName: s.customer_name ?? s.customerName,
    customerPhone: (s.customer_phone ?? s.customerPhone) || undefined,
    customerEmail: (s.customer_email ?? s.customerEmail) || undefined,
    customerAddress: (s.customer_address ?? s.customerAddress) || undefined,
    subtotal: Number(s.subtotal || 0),
    taxRate: Number((s.tax_rate ?? s.taxRate) || 0),
    taxAmount: Number((s.tax_amount ?? s.taxAmount) || 0),
    discountAmount: Number((s.discount_amount ?? s.discountAmount) || 0),
    totalAmount: Number((s.total_amount ?? s.totalAmount) || 0),
    totalCost: Number((s.total_cost ?? s.totalCost) || 0),
    grossProfit: Number((s.gross_profit ?? s.grossProfit) || 0),
    paymentMethod: s.payment_method ?? s.paymentMethod,
    amountTendered: Number((s.amount_tendered ?? s.amountTendered) || 0),
    changeGiven: Number((s.change_given ?? s.changeGiven) || 0),
    isCreditPaid: s.is_credit_paid ?? s.isCreditPaid ?? true,
    creditDueDate: (s.credit_due_date ?? s.creditDueDate) || undefined,
    paidAmount: Number((s.paid_amount ?? s.paidAmount) || 0),
    notes: cleanNotes,
    items: Array.isArray(s.items) ? s.items : [],
    ...(isReturned
      ? {
          isReturned: true,
          status: 'returned' as const,
          returnedAt: (s.returned_at ?? s.returnedAt ?? parsedMeta?.at) || undefined,
          returnReason: (s.return_reason ?? s.returnReason ?? parsedMeta?.reason) || undefined,
          refundMethod: (s.refund_method ?? s.refundMethod ?? parsedMeta?.method) || undefined,
          returnedBy: (s.returned_by ?? s.returnedBy ?? parsedMeta?.by) || undefined,
        }
      : {}),
  };
}

export function encodeCustomerNotesWithMeta(customer: {
  notes?: string | null;
  updatedAt?: string;
}): string | null {
  const baseNotes = stripCustomerUpdatedMarker(customer.notes);
  const updatedAt = customer.updatedAt ? String(customer.updatedAt).trim() : '';
  if (!updatedAt) {
    return baseNotes || null;
  }
  const marker = `<!--SAPPY_UPD:${updatedAt}-->`;
  return baseNotes ? `${baseNotes}\n${marker}` : marker;
}

export function decodeCustomerFromRemoteRow(c: any): any {
  const rawNotes = typeof c?.notes === 'string' ? c.notes : '';
  let parsedUpdatedAt: string | undefined;

  const matches = [...rawNotes.matchAll(CUSTOMER_UPDATED_MARKER_REGEX)];
  if (matches.length > 0) {
    const val = matches[matches.length - 1][1]?.trim();
    if (val) parsedUpdatedAt = val;
  }

  const cleanNotes = stripCustomerUpdatedMarker(rawNotes);

  return {
    id: c.id,
    name: c.name,
    companyName: (c.company_name ?? c.companyName) || undefined,
    phone: c.phone,
    email: c.email || undefined,
    address: c.address || undefined,
    taxNumber: (c.tax_number ?? c.taxNumber) || undefined,
    creditBalance: Number((c.credit_balance ?? c.creditBalance) || 0),
    creditLimit: Number((c.credit_limit ?? c.creditLimit) || 500),
    totalPurchased: Number((c.total_purchased ?? c.totalPurchased) || 0),
    notes: cleanNotes,
    createdAt: (c.created_at ?? c.createdAt) || new Date().toISOString(),
    updatedAt: (c.updated_at ?? c.updatedAt ?? parsedUpdatedAt) || undefined,
  };
}
