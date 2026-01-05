import { Transaction } from '@/types';
import { format } from 'date-fns';
import { normalizeHeaderKey } from '@/lib/csv-headers';
import { parseTxTime } from '@/lib/tx-time';

// Helper function to parse numbers with commas
function parseNumber(value: any): number {
  if (value === null || value === undefined || value === '') return 0;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    // Remove commas and whitespace, then parse
    const cleaned = value.replace(/,/g, '').trim();
    const parsed = parseFloat(cleaned);
    return isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

export function normalizeData(rawData: any[]): Transaction[] {
  if (!rawData || rawData.length === 0) {
    console.warn('normalizeData: Empty or invalid data array');
    return [];
  }
  
  console.log('Normalizing data, sample row keys:', Object.keys(rawData[0] || {}));
  
  return rawData.map((row, index) => {
    if (!row || typeof row !== 'object') {
      console.warn(`normalizeData: Invalid row at index ${index}:`, row);
      return null;
    }
    
    const normalized: any = {};
    
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
    
    // Convert timestamps (never "fallback to now" — drop rows we cannot date)
    const txtime = parseTxTime(normalized.txtime);
    if (!txtime) return null;
    normalized.txtime = txtime;
    
    // Convert numeric fields (handle commas)
    normalized.txamount = parseNumber(normalized.txamount);
    normalized.orderamount = parseNumber(normalized.orderamount);
    normalized.capturedamount = parseNumber(normalized.capturedamount);
    
    // Create derived fields
    normalized.transactionDate = format(txtime, 'yyyy-MM-dd');
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
    normalized.iscvvpresent = String(normalized.iscvvpresent ?? '').trim();
    normalized.upi_psp = String(normalized.upi_psp || '').trim();
    normalized.txmsg = String(normalized.txmsg || '').trim();

    // New error taxonomy fields (cashfree + pg)
    normalized.cf_errorcode = String(normalized.cf_errorcode || '').trim();
    normalized.cf_errorreason = String(normalized.cf_errorreason || '').trim();
    normalized.cf_errorsource = String(normalized.cf_errorsource || '').trim();
    normalized.cf_errordescription = String(normalized.cf_errordescription || '').trim();
    normalized.pg_errorcode = String(normalized.pg_errorcode || '').trim();
    normalized.pg_errormessage = String(normalized.pg_errormessage || '').trim();
    
    return normalized as Transaction;
  }).filter((tx) => tx !== null) as Transaction[];
}

export function extractUPIHandle(cardmasked: string | undefined): string | null {
  if (!cardmasked) return null;
  const trimmed = String(cardmasked).trim();
  if (!trimmed) return null;
  const parts = trimmed.split('@');
  return parts.length > 1 ? parts[1].trim() : null;
}

export function classifyUPIFlow(bankname: string | undefined): string {
  if (!bankname || bankname.trim() === '') return 'COLLECT';
  if (bankname.toLowerCase() === 'link') return 'INTENT';
  return bankname;
}

export function classifyCardScope(cardcountry: string | undefined): string {
  if (!cardcountry) return 'UNKNOWN';
  return cardcountry.toUpperCase() === 'IN' ? 'DOMESTIC' : 'INTERNATIONAL';
}

export function classifyBankTier(bankname: string | undefined): string {
  if (!bankname) return 'Tier 2 Bank';
  const tier1Banks = [
    'Axis Bank',
    'HDFC Bank',
    'ICICI Bank',
    'Kotak Mahindra Bank',
    'State Bank Of India',
    'Yes Bank Ltd'
  ];
  // Check exact match first, then case-insensitive match
  const normalizedBankname = bankname.trim();
  const isTier1 = tier1Banks.some(
    (tier1Bank) => 
      tier1Bank === normalizedBankname || 
      tier1Bank.toLowerCase() === normalizedBankname.toLowerCase()
  );
  return isTier1 ? 'Tier 1 Bank' : 'Tier 2 Bank';
}


