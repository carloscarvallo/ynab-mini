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

### Web UI (one command)

A small React page (server-rendered, no build step) for `POST /transactions`. You give it
an account, an optional budget ID and the path to a JSON file — the same file you would pass
to `curl --data-binary @file`.

One-time setup (Node 22+):

```bash
npm install
```

Start the API **and** the web UI together:

```bash
npm start
# api → http://localhost:5001
# web → http://127.0.0.1:5173
```

| Variable | Default | Description |
|---|---|---|
| `YNAB_API_URL` | `http://localhost:5001` | Flask API the UI posts to |
| `WEB_PORT` | `5173` | Port for the web UI |

The UI listens on `127.0.0.1` only, because it reads files from local paths. A path that
starts with `~/` is expanded to your home directory. Run the UI tests with `npm test`.

---

## Endpoints

### `GET /transactions[/<account>]`

Fetch transactions for an account.

| Param | Type | Description |
|---|---|---|
| `account` | URL segment | `checking` (default), `cc`, or a raw account UUID |
| `since` | query | Start date `YYYY-MM-DD` (default: first day of current month) |
| `budget` | query | Budget UUID, `last-used` or `default` (default: `YNAB_BUDGET_ID`) |

```bash
curl "http://localhost:5001/transactions?since=2026-01-01"
curl "http://localhost:5001/transactions/cc?since=2026-03-01"
```

### `POST /transactions[/<account>]`

Create one or more transactions. The body is a JSON **array**; each item describes one
transaction.

| Param | Type | Description |
|---|---|---|
| `account` | URL segment | Default account for every item: `checking` (default), `cc`, or a raw account UUID |
| `budget` | query | Budget UUID, `last-used` or `default` (default: `YNAB_BUDGET_ID`) |

Per-item fields:

| Field | Required | Type | Default | Description |
|---|---|---|---|---|
| `amount` | **yes** | number | — | Currency units, not milliunits. Negative is an outflow. Converted with `round(amount * 1000)`. |
| `account` | no | string | URL segment | `checking`, `cc`, or a raw account UUID. Overrides the URL default for this item only. |
| `date` | no | string | today | Transaction date, strictly `YYYY-MM-DD`. |
| `payee_name` | no | string | omitted | Payee. When absent the field is not sent to YNAB at all. |
| `memo` | no | string | `"from script"` | Free-text note. |

Minimal call — amounts only, dated today:

```bash
curl -X POST http://localhost:5001/transactions \
  -H "Content-Type: application/json" \
  -d '[{"amount": -15.50}, {"amount": -8.00, "account": "cc"}]'
```

Full call — backdated, with payees, into one specific account UUID:

```bash
curl -X POST http://localhost:5001/transactions/8f3c1e20-1234-4a5b-9c0d-ab12cd34ef56 \
  -H "Content-Type: application/json" \
  -d '[
        {"amount": -50.49, "date": "2026-08-27", "payee_name": "Deliveroo"},
        {"amount": -62.00, "date": "2026-08-26", "payee_name": "SANA Hotels", "memo": "Lisbon trip"},
        {"amount": -39.84, "date": "2026-08-26", "payee_name": "El Corte Inglés", "account": "cc"}
      ]'
```

Friendly account names (`checking`, `cc`) map to accounts in the default budget. When you
pass `?budget=` for another budget, use raw account UUIDs from that budget.

Validation runs over the whole array before anything is sent. The first bad item aborts the
request with `400` and an error naming its index — nothing is created. YNAB HTTP errors are
forwarded with their original status code.

```json
{
  "created": 3,
  "transactions": [...]
}
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
