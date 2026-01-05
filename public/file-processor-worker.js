// Web Worker for file processing (CSV parsing + normalization)
// Runs in background thread to prevent UI blocking and use multiple CPU cores

self.onmessage = function(e) {
  const { type, payload } = e.data;

  if (type === 'PROCESS_CSV_CHUNK') {
    const { chunkData, chunkIndex } = payload;
    try {
      const normalized = normalizeData(chunkData);
      self.postMessage({ 
        type: 'CHUNK_PROCESSED', 
        payload: { 
          normalized, 
          chunkIndex,
          count: normalized.length 
        } 
      });
    } catch (error) {
      self.postMessage({ 
        type: 'CHUNK_ERROR', 
        payload: { error: error.message, chunkIndex } 
      });
    }
  } else if (type === 'NORMALIZE_BATCH') {
    const { batch } = payload;
    try {
      const normalized = normalizeData(batch);
      self.postMessage({ 
        type: 'BATCH_NORMALIZED', 
        payload: { normalized } 
      });
    } catch (error) {
      self.postMessage({ 
        type: 'BATCH_ERROR', 
        payload: { error: error.message } 
      });
    }
  }
};

// Keep header normalization consistent with the main app (`lib/csv-headers.ts`).
function normalizeHeaderKey(header) {
  const raw = String(header || '').trim().toLowerCase();
  if (!raw) return '';

  const underscored = raw
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');

  const ALIASES = {
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
    merchant_id: 'merchantid',
    merchant: 'merchantid',
    bank_name: 'bankname',
    bank: 'bankname',
    card_type: 'cardtype',
    card_country: 'cardcountry',
    card_number: 'cardnumber',
    card_masked: 'cardmasked',
    tx_msg: 'txmsg',
    tx_message: 'txmsg',
    error_message: 'txmsg',
    cf_error_code: 'cf_errorcode',
    cf_error_reason: 'cf_errorreason',
    cf_error_source: 'cf_errorsource',
    cf_error_description: 'cf_errordescription',
    pg_error_code: 'pg_errorcode',
    pg_error_message: 'pg_errormessage',
    processing_card_type: 'processingcardtype',
    native_otp_url_eligible: 'nativeotpurleligible',
    native_otp_eligible: 'nativeotpurleligible',
    card_is_frictionless: 'card_isfrictionless',
    card_native_otp_action: 'card_nativeotpaction',
    order_amount: 'orderamount',
    captured_amount: 'capturedamount',
    is_cvv_present: 'iscvvpresent',
  };

  return ALIASES[underscored] || underscored;
}

// Normalize data function (same logic as main thread)
function normalizeData(rawData) {
  if (!rawData || rawData.length === 0) {
    return [];
  }
  
  return rawData.map((row, index) => {
    if (!row || typeof row !== 'object') {
      return null;
    }
    
    const normalized = {};
    
    // Normalize all keys to lowercase
    Object.keys(row).forEach((key) => {
      const lowerKey = normalizeHeaderKey(key);
      if (!lowerKey) return;
      let value = row[key];
      
      // Trim whitespace from string fields
      if (typeof value === 'string') {
        value = value.trim();
      }
      
      normalized[lowerKey] = value;
    });
    
    // Normalize enums to uppercase
    if (normalized.txstatus) {
      normalized.txstatus = String(normalized.txstatus).toUpperCase().trim();
    }
    if (normalized.paymentmode) {
      normalized.paymentmode = String(normalized.paymentmode).toUpperCase().trim();
    }
    
    // Convert timestamps
    normalized.txtime = parseDate(normalized.txtime);
    
    // Convert numeric fields (handle commas)
    normalized.txamount = parseNumber(normalized.txamount);
    normalized.orderamount = parseNumber(normalized.orderamount);
    normalized.capturedamount = parseNumber(normalized.capturedamount);
    
    // Create derived fields
    normalized.transactionDate = formatDate(normalized.txtime);
    normalized.isSuccess = normalized.txstatus === 'SUCCESS';
    normalized.isFailed = normalized.txstatus === 'FAILED';
    normalized.isUserDropped = normalized.txstatus === 'USER_DROPPED';
    
    // Ensure string fields are strings
    normalized.pg = String(normalized.pg || '').trim();
    normalized.bankname = String(normalized.bankname || '').trim();
    normalized.cardnumber = String(normalized.cardnumber || '').trim();
    normalized.cardmasked = String(normalized.cardmasked || '').trim();
    normalized.cardtype = String(normalized.cardtype || '').trim();
    normalized.cardcountry = String(normalized.cardcountry || '').trim();
    normalized.processingcardtype = String(normalized.processingcardtype || '').trim();
    normalized.nativeotpurleligible = String(normalized.nativeotpurleligible || '').trim();
    normalized.card_isfrictionless = String(normalized.card_isfrictionless || '').trim();
    normalized.card_nativeotpaction = String(normalized.card_nativeotpaction || '').trim();
    normalized.card_par = String(normalized.card_par || '').trim();
    normalized.iscvvpresent = String(normalized.iscvvpresent || '').trim();
    normalized.upi_psp = String(normalized.upi_psp || '').trim();
    normalized.txmsg = String(normalized.txmsg || '').trim();
    normalized.cf_errorcode = String(normalized.cf_errorcode || '').trim();
    normalized.cf_errorreason = String(normalized.cf_errorreason || '').trim();
    normalized.cf_errorsource = String(normalized.cf_errorsource || '').trim();
    normalized.cf_errordescription = String(normalized.cf_errordescription || '').trim();
    normalized.pg_errorcode = String(normalized.pg_errorcode || '').trim();
    normalized.pg_errormessage = String(normalized.pg_errormessage || '').trim();
    
    return normalized;
  }).filter((tx) => tx !== null);
}

// Helper function to parse numbers with commas
function parseNumber(value) {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/,/g, '').trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// Helper function to parse dates
function parseDate(value) {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  if (typeof value !== 'string') return new Date();
  
  const trimmed = value.trim();
  if (!trimmed) return new Date();
  
  // Try ISO format first
  const isoParsed = new Date(trimmed);
  if (!isNaN(isoParsed.getTime())) return isoParsed;
  
  // Fallback: try standard Date constructor
  const fallback = new Date(trimmed);
  return isNaN(fallback.getTime()) ? new Date() : fallback;
}

// Helper function to format date
function formatDate(date) {
  if (!date) return new Date().toISOString().split('T')[0];
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return new Date().toISOString().split('T')[0];
  
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}


