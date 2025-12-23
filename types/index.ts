export interface Transaction {
  // Raw fields (normalized)
  txstatus: string;
  paymentmode: string;
  pg: string;
  bankname: string;
  cardnumber: string;
  cardtype: string;
  cardcountry: string;
  processingcardtype: string;
  nativeotpurleligible: string;
  card_isfrictionless: string;
  card_nativeotpaction: string;
  upi_psp: string;
  txmsg: string;
  txtime: Date;
  txamount: number;
  orderamount: number;
  capturedamount: number;
  
  // Derived fields
  transactionDate: string; // yyyy-MM-dd
  isSuccess: boolean;
  isFailed: boolean;
  isUserDropped: boolean;
  
  // Additional normalized fields
  [key: string]: any;
}

export interface FilterState {
  dateRange: {
    start: Date | null;
    end: Date | null;
  };
  paymentModes: string[];
  merchantIds: string[];
  pgs: string[];
  banks: string[];
  cardTypes: string[];
}

export interface Metrics {
  totalCount: number;
  successCount: number;
  failedCount: number;
  userDroppedCount: number;
  sr: number; // Success Rate percentage
  successGmv: number;
  failedPercent: number;
  userDroppedPercent: number;
}

export interface DailyTrend {
  date: string;
  volume: number;
  sr: number;
  successCount: number;
  failedCount: number;
  userDroppedCount: number;
}

export interface GroupedMetrics {
  group: string;
  volume: number;
  sr: number;
  successCount: number;
  failedCount: number;
  userDroppedCount: number;
  dailyTrend?: DailyTrend[];
}

export interface FailureRCA {
  txmsg: string;
  failureCount: number;
  failurePercent: number;
  adjustedSR: number;
  impact: number; // SR impact if removed
}

export type SRMovementType = 'SR_DROP' | 'SR_IMPROVEMENT' | 'NO_SIGNIFICANT_CHANGE';
export type PrimaryCause = 'VOLUME_MIX' | 'FAILURE_SPIKE' | 'SEGMENT_DEGRADATION' | 'MIXED';

export interface DimensionAnalysis {
  dimension: string;
  dimensionValue: string;
  currentVolume: number;
  previousVolume: number;
  volumeDelta: number;
  volumeShareCurrent: number;
  volumeSharePrevious: number;
  currentSR: number;
  previousSR: number;
  srDelta: number;
  flagged: boolean;
  flagReason: 'VOLUME_SPIKE' | 'SR_DEGRADATION' | 'FAILURE_EXPLOSION' | null;
  counterfactualSR?: number; // SR if this dimension issue didn't exist
  impactOnOverallSR?: number; // How much this dimension impacts overall SR
  topFailureReason?: string; // Top failure reason (txmsg) within this dimension
  topFailureReasonCount?: number; // Count of top failure reason
}

export interface RCAInsight {
  rootCause: string;
  dimension: string;
  dimensionValue?: string;
  impactedVolumePercent: number;
  srDrop: number;
  statement: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  impact: number; // Absolute impact on SR
  counterfactualSR?: number;
  evidence?: string[];
}

export interface VolumeMixChange {
  dimension: string;
  dimensionValue: string;
  currentVolume: number;
  previousVolume: number;
  volumeDelta: number; // Absolute change
  volumeDeltaPercent: number; // % change
  volumeShareCurrent: number; // % of total transactions
  volumeSharePrevious: number; // % of total transactions
  volumeShareDelta: number; // Change in share %
  currentSR: number;
  previousSR: number;
  srDelta: number;
  impactOnOverallSR: number; // How volume shift impacts overall SR
}

export interface PeriodComparison {
  current: Metrics;
  previous: Metrics;
  srDelta: number;
  volumeDelta: number;
  insights: RCAInsight[];
  // Enhanced fields
  srMovement: SRMovementType;
  primaryCause: PrimaryCause;
  dimensionAnalyses: DimensionAnalysis[];
  successCountDelta: number;
  failedCountDelta: number;
  userDroppedDelta: number;
  failedRateCurrent: number;
  failedRatePrevious: number;
  volumeMixChanges: VolumeMixChange[]; // Volume mix analysis
}

