# ynab-mini

A minimal Python/Flask API that wraps the [YNAB REST API](https://api.ynab.com/).
Supports reading and creating transactions, and viewing monthly budgets.

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

## Running tests

```bash
python -m unittest discover -v
```
