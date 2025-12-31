# RCA Analysis Thresholds & Logic

This document explains how the RCA engine determines "significant issues" and when insights are generated.

## Current Thresholds (Configuration)

```typescript
SR_DROP_THRESHOLD = 0.5%              // Overall SR drop to trigger insight
VOLUME_CHANGE_THRESHOLD = 10%          // Volume change threshold (not currently used)
VOLUME_SHARE_SPIKE_THRESHOLD = 5%     // Failure share increase to flag as spike
SR_DEGRADATION_THRESHOLD = 2%          // SR degradation threshold (not currently used for failures)
MIN_VOLUME_SHARE_FOR_ANALYSIS = 1%    // Minimum % of total transactions to analyze
```

## Analysis Scope

**RCA Analysis is done ONLY on failure transactions:**
- Filters: `txstatus !== 'SUCCESS'`
- Only failed transactions are analyzed for dimension breakdown
- Overall metrics (SR, volume) still use ALL transactions for context

## Flagging Logic (When is something flagged?)

### 1. Failure Spike (VOLUME_SPIKE)
**Triggered when:**
- `failureShareDelta > 5%` (failure share increased by more than 5%)
- AND `failureShareCurrent >= 1%` (represents at least 1% of total transactions)

**What it means:**
- More failures are happening in this dimension
- Example: "mastercard" failures went from 2% to 28% of total failures

### 2. Failure Rate Increase (SR_DEGRADATION)
**Triggered when:**
- `failureRateDelta > 1%` (failure rate as % of total transactions increased by 1%)
- AND `volumeShareCurrent >= 1%` (represents at least 1% of total transactions)

**What it means:**
- This dimension's failure rate (% of total transactions) increased
- Example: "mastercard" failure rate went from 2.13% to 28.26% of total transactions

### 3. Failure Explosion (FAILURE_EXPLOSION)
**Triggered when:**
- Dimension is "Failure Reason"
- AND `currentFailureCount > previousFailureCount * 1.5` (50% increase)
- AND `failureShareCurrent >= 1%` (represents at least 1% of total transactions)

**What it means:**
- A specific failure reason spiked significantly
- Example: "INSUFFICIENT_FUNDS" failures increased from 10 to 25

## Insight Generation Rules

### Overall SR Movement
- **Triggered when:** `|srDelta| >= 0.5%`
- Generates insight for SR drops OR improvements

### Failure-Related Insights
- Only generated for **flagged** dimension analyses
- Top 5 insights per category (sorted by impact)
- Maximum 15 total insights

### Confidence Levels
- **HIGH:** 
  - Failure Rate Increase: `volumeShareCurrent > 2%`
  - Failure Spike: `volumeShareCurrent > 3%`
  - Failure Explosion: `volumeShareCurrent > 3%`
- **MEDIUM:** Below HIGH thresholds but still flagged
- **LOW:** Not currently used

## When "No significant issues" is shown

**Shown when:**
- No insights are generated
- This happens when:
  1. No dimensions meet the flagging criteria
  2. All flagged dimensions are filtered out (below minimum thresholds)
  3. Overall SR change is < 0.5%

## Example Scenarios

### Scenario 1: Small Failure Increase
- Previous: 1 failure (0.5% of transactions)
- Current: 3 failures (1.5% of transactions)
- **Result:** ✅ Flagged (1.5% > 1% minimum, 1% increase > 1% threshold)

### Scenario 2: Large Failure Increase
- Previous: 1 failure (2% of transactions)
- Current: 13 failures (28% of transactions)
- **Result:** ✅ Flagged (28% > 1% minimum, 26% increase > 5% spike threshold)

### Scenario 3: Tiny Failure Increase
- Previous: 1 failure (0.3% of transactions)
- Current: 2 failures (0.6% of transactions)
- **Result:** ❌ Not flagged (0.6% < 1% minimum threshold)

## Recommendations for Adjusting Thresholds

If you want to be more/less sensitive:

1. **More Sensitive (catch smaller issues):**
   - `MIN_VOLUME_SHARE_FOR_ANALYSIS = 0.5%` (was 1%)
   - `VOLUME_SHARE_SPIKE_THRESHOLD = 3%` (was 5%)
   - `Failure Rate Increase threshold = 0.5%` (was 1%)

2. **Less Sensitive (only major issues):**
   - `MIN_VOLUME_SHARE_FOR_ANALYSIS = 2%` (was 1%)
   - `VOLUME_SHARE_SPIKE_THRESHOLD = 10%` (was 5%)
   - `Failure Rate Increase threshold = 2%` (was 1%)







