import { Transaction } from '@/types';

export type FailureCategory =
  | 'CUSTOMER'
  | 'ISSUER_BANK'
  | 'PSP_APP'
  | 'GATEWAY_OR_PROCESSOR'
  | 'FRAUD_OR_RISK'
  | 'MERCHANT_OR_VALIDATION'
  | 'UNKNOWN';

function norm(value: any): string {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function compactParts(parts: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const v = norm(p);
    if (!v) continue;
    const key = v.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(v);
  }
  return out;
}

export function getFailureCategory(tx: Transaction): FailureCategory {
  // Handle USER_DROPPED separately - no error data expected
  if (tx.txstatus === 'USER_DROPPED' || tx.isUserDropped) {
    return 'CUSTOMER';
  }

  const source = norm((tx as any).cf_errorsource).toLowerCase();
  if (source) {
    if (source === 'customer') return 'CUSTOMER';
    if (source === 'issuing_bank') return 'ISSUER_BANK';
    if (source === 'psp_app') return 'PSP_APP';
    if (source === 'payment_gateway' || source === 'gateway' || source === 'processor') return 'GATEWAY_OR_PROCESSOR';
  }

  const reason = [
    norm((tx as any).cf_errorreason),
    norm((tx as any).cf_errordescription),
    norm((tx as any).pg_errormessage),
    norm((tx as any).txmsg),
  ]
    .join(' ')
    .toLowerCase();

  if (!reason) return 'UNKNOWN';

  // Customer-driven / auth failures
  if (
    reason.includes('invalid_pin') ||
    reason.includes('incorrect upi pin') ||
    reason.includes('customer_declined') ||
    reason.includes('cancelled by the customer') ||
    reason.includes('invalid cvv') ||
    reason.includes('invalid card verification') ||
    reason.includes('did not enter otp') ||
    reason.includes('could not complete their otp')
  ) {
    return 'CUSTOMER';
  }

  // Balance / limits
  if (reason.includes('insufficient_funds') || reason.includes('insufficient funds') || reason.includes('exceeds_credit_limit') || reason.includes('credit limit')) {
    return 'ISSUER_BANK';
  }

  // Bank/issuer declines + timeouts
  if (
    reason.includes('issuing_bank') ||
    reason.includes('issuer bank') ||
    reason.includes('debit_failed') ||
    reason.includes('declined the transaction') ||
    reason.includes('high_response_time') ||
    reason.includes('did not respond in time')
  ) {
    return 'ISSUER_BANK';
  }

  // PSP/app issues
  if (reason.includes('psp_app') || reason.includes('session_expired') || reason.includes('session has been expired') || reason.includes('expired')) {
    return 'PSP_APP';
  }

  // Risk/fraud
  if (reason.includes('fraud') || reason.includes('risk') || reason.includes('fraud_detected')) {
    return 'FRAUD_OR_RISK';
  }

  // Validation/config
  if (reason.includes('validation problem') || reason.includes('not supported') || reason.includes('merchant')) {
    return 'MERCHANT_OR_VALIDATION';
  }

  // Gateway/processor technical issues
  if (reason.includes('technical error') || reason.includes('processor_declined') || reason.includes('payment gateway')) {
    return 'GATEWAY_OR_PROCESSOR';
  }

  return 'UNKNOWN';
}

/**
 * Returns a stable, human-friendly label for failure grouping + display.
 * Preference order:
 * - Check for USER_DROPPED status first (no error data expected)
 * - `cf_errorcode` (most stable taxonomy)
 * - `pg_errorcode`
 * - `txmsg`
 * Then enrich with `cf_errorreason` / `cf_errorsource` / `cf_errordescription` / `pg_errormessage`.
 */
export function getFailureLabel(tx: Transaction): string {
  // Handle USER_DROPPED separately - no error data expected
  if (tx.txstatus === 'USER_DROPPED' || tx.isUserDropped) {
    return 'User Abandoned Transaction';
  }

  const cfCode = norm((tx as any).cf_errorcode);
  const pgCode = norm((tx as any).pg_errorcode);
  const txMsg = norm((tx as any).txmsg);

  const cfReason = norm((tx as any).cf_errorreason);
  const cfSource = norm((tx as any).cf_errorsource);
  const cfDesc = norm((tx as any).cf_errordescription);
  const pgMsg = norm((tx as any).pg_errormessage);

  const primary = cfCode || pgCode || txMsg || 'Unknown';

  // Keep the label useful but not overly unique; include reason/source/desc only if present.
  const suffixParts = compactParts([cfReason || txMsg, cfSource, cfDesc || pgMsg]);

  // Avoid repeating the primary in suffix
  const pr = primary.toLowerCase();
  const filteredSuffix = suffixParts.filter((p) => p.toLowerCase() !== pr);

  if (filteredSuffix.length === 0) return primary;

  // Slightly structured formatting
  const [first, ...rest] = filteredSuffix;
  const restText = rest.length ? ` • ${rest.join(' • ')}` : '';
  return `${primary} — ${first}${restText}`;
}



