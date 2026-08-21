# Changelog

All notable changes to the QuickBooks Online MCP Server are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Security

- The local troubleshooting error log could leak customer data. When QuickBooks
  rejects a request (a "Fault"), the raw response body — which can echo the
  submitted customer name, email, address, or amount — was being written to
  the log verbatim. It now records only the fixed, non-sensitive error code
  and message from Intuit's Fault catalogue; the rest of the body is withheld.
- The AES-256-GCM refresh-token migration could silently leave the old
  plaintext token on disk. A token store written with an `export ` prefix, a
  `KEY: value` line, or extra whitespace — all forms the server's own `.env`
  loader accepts — was read and encrypted correctly, but the plaintext line
  wasn't recognized for removal, so it stayed on disk indefinitely even though
  the migration reported success. Removal now uses the same matching rules as
  the reader, and the migration verifies the plaintext line is actually gone
  before it logs success.
- The AES key protecting the refresh token can now be stored on a different
  path than the token store itself via `QUICKBOOKS_TOKEN_KEY_PATH`. By default
  the key sits right beside the token store, which only protects against a
  single-file leak — a backup or directory copy still captures both files
  together.
- A token store reached through a symlink (containers, persistent volumes)
  could keep looser file permissions than intended after being rewritten with
  the new encrypted token; it's now explicitly restricted to owner-only (0600)
  after every write, matching the non-symlink path.
- The OAuth callback server now binds to loopback only instead of every
  network interface, so the callback URL (which briefly carries a live
  authorization code) isn't reachable from other machines on the network
  during the `npm run auth` handshake.

### Fixed

- A failed OAuth token exchange (expired code, network blip, Intuit outage)
  left the local callback server's port permanently open, so every later
  `npm run auth` attempt failed with a confusing "address in use" error
  instead of the real problem — the only fix was restarting the process. The
  server is now released whenever the exchange fails.
- Two authorization attempts starting at nearly the same moment could produce
  a stray "failed to obtain tokens" error even though the first attempt was
  still legitimately in progress. A concurrent request now waits for the
  in-flight handshake to finish instead of failing early.
- `npm run auth` could not complete a **production** OAuth handshake at all —
  `startOAuthFlow()` refused unconditionally whenever `QUICKBOOKS_ENVIRONMENT=production`,
  even with a public HTTPS redirect (e.g. an ngrok tunnel) already configured per this
  README's own "Production Setup" section. `authenticate()` now accepts an
  `{ interactive: true }` option, set only by the `npm run auth` CLI entry point, that
  allows the flow to proceed in production and authorize against the configured
  `QUICKBOOKS_REDIRECT_URI` instead of a hardcoded localhost URL. Every other caller —
  in particular the MCP server's own automatic reauth-on-refresh-failure path — leaves
  this off, so a dead token discovered mid-life still fails fast with an actionable error
  rather than opening a browser window nobody is watching. Verified against a real
  production company end to end.

### Added

- Every caught error is now logged to a local troubleshooting file
  (`~/.config/quickbooks-mcp/error.log` by default, or beside the token store when
  `QUICKBOOKS_TOKEN_STORE_PATH` is set; override directly with `QUICKBOOKS_ERROR_LOG_PATH`)
  with the request operation, HTTP status, and QuickBooks' `intuit_tid` header when present —
  the identifier Intuit support uses to look up a specific failed call. Addresses their App
  Assessment Questionnaire's request to capture `intuit_tid`. This is a side-channel log only:
  the error message returned to the MCP client is unchanged, and request/response bodies are
  never written to the log. The log is capped at 5 MB and rotates to a single backup file,
  so a persistent failure (a dead token, a QuickBooks outage) can't grow it without bound.

### Security

- The refresh token is now encrypted at rest with AES-256-GCM rather than stored as
  plaintext in the token store. It is written as `QUICKBOOKS_REFRESH_TOKEN_ENC` (an
  authenticated ciphertext blob); the AES key is generated on first use and kept in a
  separate sibling file, `.qbo-token-key` (mode `0600`), alongside the token store —
  never inside it. Brings the server in line with Intuit's app security requirement
  that the refresh token be encrypted with a symmetric algorithm and the key stored
  separately. A store still holding a legacy plaintext `QUICKBOOKS_REFRESH_TOKEN` is
  migrated automatically and transparently on the next start; no action is required.
  `QUICKBOOKS_REALM_ID` is unaffected (it's a company identifier, not a secret).

### Fixed

- OAuth callback server (`startOAuthFlow()`) no longer renders HTML directly on the
  `/callback` URL, which carries the auth code/state in its query string. It now returns a
  `302` redirect to a param-free route (`/callback/processing`, `/callback/complete`, or
  `/callback/error`), and that route renders the page. Brings the flow in line with Intuit's
  QBO app security requirements ("must not return HTML content" at a URL carrying sensitive
  parameters). Behavior (state check, duplicate-callback guard, saved tokens, server
  shutdown) is unchanged — only the response mechanics.
- `npm run lint` was failing for everyone — the repo had ESLint 9 as a dependency but no
  `eslint.config.js`. Added a flat config so the lint gate actually runs.

## [0.0.1] - 2024-01-13

### Summary

Comprehensive expansion of the QuickBooks Online MCP server from a basic implementation to a full-featured API integration with **143 tools**, **29 entity types**, **11 financial reports**, and **100% test coverage**.

---

### Added

#### Entity Handlers (Full CRUD Operations)

Extended the server with complete Create, Read, Update, Delete, and Search operations for 29 entity types:

**Financial Transactions**
- `Payment` - Customer payment recording and management
- `SalesReceipt` - Point-of-sale transaction records
- `CreditMemo` - Customer credit adjustments
- `RefundReceipt` - Customer refund processing
- `Deposit` - Bank deposit recording with line item support
- `Transfer` - Inter-account fund transfers
- `PurchaseOrder` - Vendor purchase orders with shipping addresses
- `VendorCredit` - Vendor credit adjustments

**Time & Activity**
- `TimeActivity` - Employee/vendor time tracking with billable status

**Organization**
- `Class` - Transaction classification (cost centers)
- `Department` - Departmental organization
- `Term` - Payment terms (Net 30, Due on Receipt, etc.)
- `PaymentMethod` - Payment method types (Cash, Check, Credit Card)

**Tax Entities (Read-only)**
- `TaxCode` - Tax code lookup and search
- `TaxRate` - Tax rate lookup and search
- `TaxAgency` - Tax agency lookup and search

**Company & Attachments**
- `CompanyInfo` - Company profile management with address support
- `Attachable` - File attachment management

#### Financial Reports

Added 11 financial report endpoints:

| Report | Handler | Description |
|--------|---------|-------------|
| Balance Sheet | `get-quickbooks-balance-sheet.handler.ts` | Assets, liabilities, and equity snapshot |
| Profit & Loss | `get-quickbooks-profit-and-loss.handler.ts` | Income statement with accounting method options |
| Cash Flow | `get-quickbooks-cash-flow.handler.ts` | Statement of cash flows |
| Trial Balance | `get-quickbooks-trial-balance.handler.ts` | Debit/credit balance verification |
| General Ledger | `get-quickbooks-general-ledger.handler.ts` | Complete transaction history |
| Customer Sales | `get-quickbooks-customer-sales.handler.ts` | Sales analysis by customer |
| Customer Balance | `get-quickbooks-customer-balance.handler.ts` | Outstanding customer balances |
| Aged Receivables | `get-quickbooks-aged-receivables.handler.ts` | AR aging with customer filter |
| Aged Receivables Detail | `get-quickbooks-aged-receivables-detail.handler.ts` | Detailed AR aging breakdown |
| Aged Payables | `get-quickbooks-aged-payables.handler.ts` | AP aging analysis |
| Vendor Expenses | `get-quickbooks-vendor-expenses.handler.ts` | Expense analysis by vendor |

#### Testing Infrastructure

**Jest Configuration with ESM Support**
- Configured Jest with `--experimental-vm-modules` for native ESM testing
- Set up `ts-jest` with ESM preset for TypeScript compilation
- Created `tsconfig.test.json` for test-specific TypeScript settings

**Mock System**
- Created `tests/mocks/quickbooks.mock.ts` with comprehensive QuickBooks client mocking
- Implemented `mockQuickBooksInstance` with all API method stubs
- Added `resetAllMocks()` helper for test isolation

**Test Suites (335 tests total)**
- `class.handlers.test.ts` - Class entity CRUD tests
- `company-attachable.handlers.test.ts` - Company info and attachable tests
- `credit-memo.handlers.test.ts` - Credit memo CRUD tests
- `department-term-paymentmethod.handlers.test.ts` - Settings entity tests
- `deposit-transfer.handlers.test.ts` - Banking transaction tests
- `payment.handlers.test.ts` - Payment CRUD tests
- `refund-purchase-order-vendor-credit.handlers.test.ts` - Vendor transaction tests
- `reports.handlers.test.ts` - All 11 financial report tests
- `sales-receipt.handlers.test.ts` - Sales receipt CRUD tests
- `tax-entities.handlers.test.ts` - Tax entity read/search tests
- `time-activity.handlers.test.ts` - Time tracking tests
- `format-error.test.ts` - Error formatting helper tests

#### Documentation

- Comprehensive `README.md` with:
  - Badge indicators (143 tools, 29 entities, 11 reports)
  - Complete tool reference with collapsible sections
  - Quick start guide with installation instructions
  - Claude Code MCP configuration examples
  - Authentication setup guide (OAuth 2.0)
  - Project structure documentation

---

### Technical Implementation Details

#### Handler Architecture Pattern

Each handler follows a consistent pattern:

```typescript
// 1. Import dependencies
import { quickbooksClient } from "../clients/quickbooks-client.js";
import { ToolResponse } from "../types/tool-response.js";
import { formatError } from "../helpers/format-error.js";

// 2. Define typed input interface
export interface CreateEntityInput {
  required_field: string;
  optional_field?: string;
}

// 3. Implement async handler with error handling
export async function createQuickbooksEntity(data: CreateEntityInput): Promise<ToolResponse<any>> {
  try {
    await quickbooksClient.authenticate();
    const quickbooks = quickbooksClient.getQuickbooks();

    // Build payload with conditional field mapping
    const payload: any = { RequiredField: data.required_field };
    if (data.optional_field) payload.OptionalField = data.optional_field;

    // Execute QuickBooks API call with callback wrapper
    return new Promise((resolve) => {
      quickbooks.createEntity(payload, (err: any, result: any) => {
        if (err) resolve({ result: null, isError: true, error: formatError(err) });
        else resolve({ result, isError: false, error: null });
      });
    });
  } catch (error) {
    return { result: null, isError: true, error: formatError(error) };
  }
}
```

#### ESM Testing Pattern

Tests use dynamic imports after mock setup for ESM compatibility:

```typescript
import { jest, describe, it, expect, beforeEach } from '@jest/globals';
import { mockQuickbooksClient, mockQuickBooksInstance, resetAllMocks } from '../../mocks/quickbooks.mock';

// Mock MUST be defined before dynamic imports
jest.unstable_mockModule('../../../src/clients/quickbooks-client', () => ({
  quickbooksClient: mockQuickbooksClient,
}));

// Dynamic import AFTER mock setup
const { createEntity } = await import('../../../src/handlers/create-entity.handler');

describe('Entity Handlers', () => {
  beforeEach(() => {
    resetAllMocks(); // Reset all mock state between tests
  });

  it('should create entity successfully', async () => {
    mockQuickBooksInstance.createEntity.mockImplementation((payload, cb) =>
      cb(null, { Id: '123' })
    );

    const result = await createEntity({ required_field: 'value' });

    expect(result.isError).toBe(false);
    expect(result.result).toEqual({ Id: '123' });
  });
});
```

#### Branch Coverage Strategy

Achieved 100% branch coverage by testing:

1. **Success paths** - Normal API responses
2. **API error paths** - QuickBooks API returning errors via callback
3. **Authentication error paths** - Token refresh/auth failures
4. **Optional field variations** - Testing with and without optional fields
5. **Empty response handling** - QueryResponse with missing entity arrays

Example of branch coverage for optional fields:

```typescript
// Handler code with branches:
if (data.company_addr) {
  payload.CompanyAddr = {};
  if (data.company_addr.line1) payload.CompanyAddr.Line1 = data.company_addr.line1;  // Branch A
  if (data.company_addr.city) payload.CompanyAddr.City = data.company_addr.city;      // Branch B
}

// Tests to cover all branches:
it('should update with line1 only', async () => {
  await updateCompanyInfo({ id: '1', sync_token: '0', company_addr: { line1: '123 Main' } });
});

it('should update with city only', async () => {
  await updateCompanyInfo({ id: '1', sync_token: '0', company_addr: { city: 'LA' } });
});
```

---

### Configuration Changes

#### jest.config.js

```javascript
export default {
  preset: 'ts-jest/presets/default-esm',
  testEnvironment: 'node',
  coverageThreshold: {
    global: {
      branches: 100,
      functions: 100,
      lines: 100,
      statements: 100,
    },
  },
  // ESM support
  extensionsToTreatAsEsm: ['.ts'],
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
};
```

#### package.json (test script)

```json
{
  "scripts": {
    "test": "NODE_OPTIONS='--experimental-vm-modules' jest"
  }
}
```

---

### Coverage Statistics

| Metric | Coverage |
|--------|----------|
| Statements | 100% |
| Branches | 100% |
| Functions | 100% |
| Lines | 100% |

**Test Summary:**
- 12 test suites
- 335 tests
- 0 snapshots
- ~8 seconds execution time

---

### File Structure

```
mcp-quickbooks-online/
├── src/
│   ├── clients/
│   │   └── quickbooks-client.ts      # OAuth client wrapper
│   ├── handlers/                      # 87 handler files
│   │   ├── create-quickbooks-*.ts    # Create operations
│   │   ├── get-quickbooks-*.ts       # Read operations
│   │   ├── update-quickbooks-*.ts    # Update operations
│   │   ├── delete-quickbooks-*.ts    # Delete operations
│   │   └── search-quickbooks-*.ts    # Search operations
│   ├── tools/                         # MCP tool definitions
│   ├── helpers/
│   │   └── format-error.ts           # Error formatting utility
│   ├── types/
│   │   └── tool-response.ts          # Response type definitions
│   └── index.ts                       # MCP server entry point
├── tests/
│   ├── mocks/
│   │   └── quickbooks.mock.ts        # QuickBooks client mock
│   └── unit/
│       ├── handlers/                  # 11 handler test files
│       └── helpers/                   # Helper tests
├── jest.config.js                     # Jest ESM configuration
├── tsconfig.test.json                # Test TypeScript config
├── README.md                          # Comprehensive documentation
└── CHANGELOG.md                       # This file
```

---

### Why These Changes Were Made

1. **Complete API Coverage**: The original Intuit repo provided basic functionality. This expansion provides access to all QuickBooks Online API capabilities needed for real accounting workflows.

2. **Test Coverage**: 100% test coverage ensures reliability and catches regressions. The ESM testing pattern enables modern JavaScript module testing.

3. **Type Safety**: TypeScript interfaces for all inputs provide compile-time validation and better IDE support.

4. **Consistent Patterns**: All handlers follow the same architecture, making the codebase maintainable and predictable.

5. **Error Handling**: Standardized error formatting through `formatError()` provides consistent error messages across all operations.

---

### Migration Notes

If upgrading from the original Intuit implementation:

1. All original functionality is preserved
2. New handlers use the same client and authentication
3. Tool names follow the pattern `{action}_{entity}` (e.g., `create_payment`)
4. All tools return `ToolResponse<T>` with `isError`, `result`, and `error` fields

---

## [Unreleased]

### Planned

- Integration tests with QuickBooks sandbox
- Batch operation support
- Webhook handling for real-time updates
- Report export to CSV/PDF formats
