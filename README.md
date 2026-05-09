# ynab-mini

A minimal Python/Flask API that wraps the [YNAB REST API](https://api.ynab.com/).
Supports reading transactions, viewing monthly budgets, and migrating transactions between budgets.

## Setup

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp .env.example .env
# Fill in your YNAB_API_TOKEN and other values
```

Get your API token at [app.ynab.com/settings/developer](https://app.ynab.com/settings/developer).

Start the server:

```bash
python api.py
# Listening on http://localhost:5001
```

---

## Endpoints

### `GET /transactions[/<account>]`

Fetch transactions for an account.

| Param | Type | Description |
|---|---|---|
| `account` | URL segment | `checking` (default), `cc`, or a raw account UUID |
| `since` | query | Start date `YYYY-MM-DD` (default: first day of current month) |

```bash
curl "http://localhost:5001/transactions?since=2026-01-01"
curl "http://localhost:5001/transactions/cc?since=2026-03-01"
```

### `POST /transactions[/<account>]`

Create one or more transactions.

```bash
curl -X POST http://localhost:5001/transactions \
  -H "Content-Type: application/json" \
  -d '[{"amount": -15.50}, {"amount": -8.00, "account": "cc"}]'
```

### `GET /budget[/<budget_id>]`

Fetch the monthly budget plan grouped by category group.

| Param | Type | Description |
|---|---|---|
| `budget_id` | URL segment | Budget UUID (default: `YNAB_BUDGET_ID`) |
| `month` | query | `YYYY-MM` (default: current month) |

```bash
curl "http://localhost:5001/budget?month=2026-04"
```

---

## Migration — moving transactions between budgets

Use these three endpoints in order to migrate transactions from one YNAB budget to another.

### Step 1 — Configure account mapping

Copy the example file and fill in your real account UUIDs:

```bash
cp account_map.example.json account_map.json
```

```json
{
  "accounts": [
    {
      "name": "Revolut Checking",
      "source": "<source-budget-account-uuid>",
      "destination": "<dest-budget-account-uuid>"
    },
    {
      "name": "Revolut CC",
      "source": "<source-budget-account-uuid>",
      "destination": "<dest-budget-account-uuid>"
    }
  ]
}
```

> `account_map.json` is gitignored — your real UUIDs never get committed.

Set the destination budget in `.env`:

```
YNAB_SOURCE_BUDGET_ID=<source-budget-uuid>
YNAB_DEST_BUDGET_ID=<destination-budget-uuid>
```

---

### Step 2 — `GET /migrate/download`

Fetches all transactions from the source budget and writes them to `transactions_export.json`.

| Param | Type | Description |
|---|---|---|
| `source_budget` | query | Override source budget UUID (default: `YNAB_SOURCE_BUDGET_ID`) |
| `since` | query | Start date `YYYY-MM-DD` (default: first day of current month) |

```bash
curl "http://localhost:5001/migrate/download?since=2026-01-01"
```

```json
{
  "count": 134,
  "file": "transactions_export.json"
}
```

---

### Step 3 — `GET /migrate/validate`

Pre-flight check. Verifies that:
- `transactions_export.json` exists and is readable
- `account_map.json` exists, is valid, and has no duplicate source IDs
- Every account in the export has a mapping in `account_map.json`
- The destination budget exists in YNAB

| Param | Type | Description |
|---|---|---|
| `dest_budget` | query | Override destination budget UUID (default: `YNAB_DEST_BUDGET_ID`) |

```bash
curl "http://localhost:5001/migrate/validate"
```

**Ready (`200`):**
```json
{
  "ready": true,
  "destination_budget": {
    "id": "...",
    "name": "My New Budget",
    "exists": true
  },
  "export": {
    "source_budget_id": "...",
    "since_date": "2026-01-01",
    "downloaded_at": "2026-05-09T14:00:00+00:00",
    "total_transactions": 134
  },
  "accounts_mapped": [
    { "name": "Revolut Checking", "source": "...", "destination": "...", "transaction_count": 98 },
    { "name": "Revolut CC",       "source": "...", "destination": "...", "transaction_count": 36 }
  ],
  "accounts_missing": []
}
```

**Not ready (`422`):** `accounts_missing` lists every source account ID that has no entry in `account_map.json`. Add the missing entries and re-validate before pushing.

> Only proceed to Step 4 when `ready` is `true`.

---

### Step 4 — `POST /migrate/push`

Reads `transactions_export.json`, remaps account IDs via `account_map.json`, and bulk-creates the transactions in the destination budget.

| Param | Type | Description |
|---|---|---|
| `dest_budget` | query | Override destination budget UUID (default: `YNAB_DEST_BUDGET_ID`) |

```bash
curl -X POST "http://localhost:5001/migrate/push"
```

```json
{
  "created": 134,
  "transactions": [...],
  "skipped": []
}
```

`skipped` contains any transactions whose `account_id` had no mapping — inspect these and update `account_map.json` if needed.

---

## Running tests

```bash
python -m unittest discover -v
```
