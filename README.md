# SR Analytics Dashboard

A production-grade Success Rate (SR) Analytics Dashboard built with React.js, TypeScript, and Next.js. This dashboard is designed for Ops, Product, Risk, and Engineering teams to monitor SR trends, identify drops, perform deep Root Cause Analysis (RCA), and make routing and product decisions.

## Features

### Core Functionality
- **File Upload**: Drag & drop CSV/XLSX files with support for 100k+ rows
- **Data Normalization**: Automatic normalization of all transaction data
- **Real-time Filtering**: Sticky filters for date range, payment mode, PG, bank, and card type
- **Multi-level Drilldowns**: Deep analysis across multiple dimensions

### Tabs & Analysis

#### Overview Tab
- KPI cards: Total Volume, Overall SR %, Success GMV, Failed %, User Dropped %
- Daily trend chart with dual-axis (Volume + SR %)

#### UPI Tab
- **PG Level**: Volume, SR, Failed count, User dropped count per PG
- **Intent vs Collect**: Flow classification and SR analysis
- **Handle Level**: Top handles by volume with SR per handle
- **PSP Level**: UPI PSP analysis with daily trends
- **Failure RCA**: Root cause analysis with adjusted SR calculations

#### Cards Tab
- **PG Level**: Card transaction analysis by payment gateway
- **Card Type**: VISA, MASTERCARD, RUPAY, AMEX analysis
- **Domestic vs IPG**: Comparison of domestic vs international cards
- **Authentication & Friction**: Analysis by processing type, OTP eligibility, frictionless status
- **Failure RCA**: Card-specific failure root cause analysis

#### Netbanking Tab
- **PG Level**: Netbanking transactions by payment gateway
- **Bank Level**: Bank-wise SR analysis
- **Failure RCA**: Netbanking failure root cause analysis

#### RCA Tab (Most Important)
- **Period Comparison**: Current vs previous period analysis
- **Drop Detection**: Automatic detection of SR drops, volume shifts, failure spikes
- **Auto-generated Insights**: AI-powered RCA statements explaining root causes
- **Impact Analysis**: Shows dimension, impacted volume %, and SR impact

## Technology Stack

- **Framework**: Next.js 14 (App Router) with TypeScript
- **State Management**: Zustand
- **Charts**: Apache ECharts (echarts-for-react)
- **Tables**: TanStack Table with react-virtual for virtualization
- **Styling**: Tailwind CSS with dark mode
- **File Parsing**: PapaParse (CSV), XLSX (Excel)
- **Date Handling**: date-fns

## Getting Started

### Prerequisites
- Node.js 18+ 
- npm or yarn

### Installation

```bash
# Install dependencies
npm install

# Run development server
npm run dev

# Build for production
npm run build

# Start production server
npm start
```

The application will be available at `http://localhost:3000`

## Data Format

The dashboard expects CSV or XLSX files with the following columns (case-insensitive):

### Required Columns
- `txstatus`: Transaction status (SUCCESS, FAILED, USER_DROPPED, etc.)
- `paymentmode`: Payment mode (UPI, CREDIT_CARD, DEBIT_CARD, NET_BANKING, etc.)
- `txtime`: Transaction timestamp
- `txamount`: Transaction amount

### Optional Columns (for advanced analysis)
- `pg`: Payment gateway
- `bankname`: Bank name
- `cardnumber`: Card number or UPI handle
- `cardtype`: Card type (VISA, MASTERCARD, etc.)
- `cardcountry`: Card country code
- `processingcardtype`: Processing card type
- `nativeotpurleligible`: Native OTP eligibility
- `card_isfrictionless`: Frictionless status
- `card_nativeotpaction`: Native OTP action
- `upi_psp`: UPI PSP
- `txmsg`: Transaction message/error message
- `orderamount`: Order amount
- `capturedamount`: Captured amount

## Performance

- **Web Workers**: Heavy aggregations run in background threads
- **Memoization**: All selectors and computed values are memoized
- **Virtualized Tables**: Large tables use virtualization for smooth scrolling
- **Optimized Charts**: Charts render in <200ms with smooth transitions

## Design

- **Dark Mode**: Default dark theme optimized for long viewing sessions
- **Fintech Premium**: Clean, minimal design with high contrast
- **Smooth Animations**: All interactions are smooth and jank-free
- **Responsive**: Works on desktop and tablet devices

## Metric Definitions

### Core Metrics
- **TOTAL_COUNT**: Total number of transactions
- **SUCCESS_COUNT**: Count of transactions with status = 'SUCCESS'
- **FAILED_COUNT**: Count of transactions with status = 'FAILED'
- **USER_DROPPED_COUNT**: Count of transactions with status = 'USER_DROPPED'
- **SR**: 100 * SUCCESS_COUNT / TOTAL_COUNT (rounded to 2 decimal places)
- **SUCCESS_GMV**: Sum of txamount where status = 'SUCCESS'

### Derived Fields
- `transactionDate`: Formatted date (yyyy-MM-dd)
- `isSuccess`: Boolean flag for success transactions
- `isFailed`: Boolean flag for failed transactions
- `isUserDropped`: Boolean flag for user dropped transactions

## License

Proprietary - Internal Use Only


