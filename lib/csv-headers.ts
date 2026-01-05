/**
 * Shared CSV/header normalization used on both client and server.
 *
 * Goal: make the app resilient to common export variants like:
 * - "Tx Status" / "tx_status" / "transaction_status"  -> "txstatus"
 * - "Payment Mode" / "payment_mode"                   -> "paymentmode"
 * - "Tx Time" / "tx_time" / "transaction_time"        -> "txtime"
 *
 * This is intentionally dependency-free so it can be imported from:
 * - client components / store
 * - API route handlers (nodejs runtime)
 * - data normalization helpers
 */

const ALIASES: Record<string, string> = {
  // Required fields (common variants)
  tx_status: 'txstatus',
  transaction_status: 'txstatus',
  status: 'txstatus',

  payment_mode: 'paymentmode',
  payment_method: 'paymentmode',

  tx_time: 'txtime',
  transaction_time: 'txtime',
  transaction_timestamp: 'txtime',
  timestamp: 'txtime',

  tx_amount: 'txamount',
  transaction_amount: 'txamount',
  amount: 'txamount',

  // Common dimensions
  merchant_id: 'merchantid',
  merchant: 'merchantid',

  bank_name: 'bankname',
  bank: 'bankname',

  card_type: 'cardtype',
  card_country: 'cardcountry',
  card_number: 'cardnumber',
  card_masked: 'cardmasked',

  // Error taxonomy (common export variants)
  tx_msg: 'txmsg',
  tx_message: 'txmsg',
  error_message: 'txmsg',

  cf_error_code: 'cf_errorcode',
  cf_error_reason: 'cf_errorreason',
  cf_error_source: 'cf_errorsource',
  cf_error_description: 'cf_errordescription',

  pg_error_code: 'pg_errorcode',
  pg_error_message: 'pg_errormessage',

  // Cards auth/friction fields
  processing_card_type: 'processingcardtype',
  native_otp_url_eligible: 'nativeotpurleligible',
  native_otp_eligible: 'nativeotpurleligible',
  card_is_frictionless: 'card_isfrictionless',
  card_native_otp_action: 'card_nativeotpaction',

  // Amount fields
  order_amount: 'orderamount',
  captured_amount: 'capturedamount',

  // CVV
  is_cvv_present: 'iscvvpresent',
};

export function normalizeHeaderKey(header: string): string {
  const raw = String(header ?? '').trim().toLowerCase();
  if (!raw) return '';

  // Normalize separators to underscores and collapse repeats.
  // Examples:
  // - "Tx Status" -> "tx_status"
  // - "cf error code" -> "cf_error_code"
  // - "pg-error-message" -> "pg_error_message"
  const underscored = raw
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  return ALIASES[underscored] ?? underscored;
}


