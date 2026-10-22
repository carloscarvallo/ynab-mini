import os
import re
from datetime import date, datetime

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

from budget import budget_bp
from migrate import migrate_bp

load_dotenv()

app = Flask(__name__)
app.register_blueprint(budget_bp)
app.register_blueprint(migrate_bp)

API_TOKEN = os.getenv("YNAB_API_TOKEN")
BUDGET_ID = os.getenv("YNAB_BUDGET_ID", "last-used")
ACCOUNT_ID = os.getenv("YNAB_ACCOUNT_ID", "")
REVOLUT_CC_ACCOUNT_ID = os.getenv("YNAB_REVOLUT_CC_ACCOUNT_ID", "")
BASE_URL = "https://api.ynab.com/v1"

ACCOUNT_MAP = {
    "checking": ACCOUNT_ID,
    "cc": REVOLUT_CC_ACCOUNT_ID,
}

YNAB_HEADERS = {"Authorization": f"Bearer {API_TOKEN}"}

UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


def _resolve_account(key: str) -> str | None:
    if key in ACCOUNT_MAP:
        return ACCOUNT_MAP[key]
    if UUID_RE.match(key):
        return key
    return None


BUDGET_ALIASES = {"last-used", "default"}
INVALID_BUDGET_ERROR = "Invalid budget. Use a budget UUID, 'last-used' or 'default'."


def _resolve_budget(budget_id: str) -> str | None:
    if budget_id in BUDGET_ALIASES or UUID_RE.match(budget_id):
        return budget_id
    return None


def _budget_from_args() -> str | None:
    return _resolve_budget(request.args.get("budget", BUDGET_ID))


DEFAULT_MEMO = "from script"


def _build_transaction(
    amount: float,
    account_id: str = ACCOUNT_ID,
    txn_date: str | None = None,
    payee_name: str | None = None,
    memo: str = DEFAULT_MEMO,
) -> dict:
    transaction = {
        "account_id": account_id,
        "date": txn_date or date.today().isoformat(),
        "amount": int(round(amount * 1000)),
        "memo": memo,
        "approved": True,
    }
    if payee_name is not None:
        transaction["payee_name"] = payee_name
    return transaction


def _validate_item(item: dict, index: int, default_account_key: str) -> tuple[dict | None, str | None]:
    if not isinstance(item, dict):
        return None, f"Item at index {index} must be a JSON object"
    if "amount" not in item:
        return None, f"Item at index {index} is missing 'amount'"
    if not isinstance(item["amount"], (int, float)):
        return None, f"Item at index {index}: 'amount' must be a number"

    account_key = item.get("account", default_account_key)
    if not isinstance(account_key, str):
        return None, f"Item at index {index}: 'account' must be a string"
    account_id = _resolve_account(account_key.lower())
    if not account_id:
        return None, f"Item at index {index}: unknown account '{account_key.lower()}'. Use a friendly name {list(ACCOUNT_MAP.keys())} or a valid UUID."

    txn_date = item.get("date")
    if txn_date is not None:
        try:
            datetime.strptime(txn_date, "%Y-%m-%d")
        except (TypeError, ValueError):
            return None, f"Item at index {index}: 'date' must be a string in YYYY-MM-DD format"

    memo = item.get("memo", DEFAULT_MEMO)
    if not isinstance(memo, str):
        return None, f"Item at index {index}: 'memo' must be a string"

    payee_name = item.get("payee_name")
    if payee_name is not None and not isinstance(payee_name, str):
        return None, f"Item at index {index}: 'payee_name' must be a string"

    return _build_transaction(item["amount"], account_id, txn_date, payee_name, memo), None


@app.get("/transactions")
@app.get("/transactions/<account_key>")
def get_transactions(account_key: str = "checking"):
    account_key = account_key.lower()
    account_id = _resolve_account(account_key)
    if not account_id:
        return jsonify({"error": f"Unknown account '{account_key}'. Use a friendly name {list(ACCOUNT_MAP.keys())} or a valid UUID."}), 400

    budget_id = _budget_from_args()
    if not budget_id:
        return jsonify({"error": INVALID_BUDGET_ERROR}), 400

    since_date = request.args.get("since", date.today().replace(day=1).isoformat())

    try:
        response = requests.get(
            f"{BASE_URL}/budgets/{budget_id}/transactions",
            headers=YNAB_HEADERS,
            params={"since_date": since_date, "account_id": account_id},
        )
        response.raise_for_status()
    except requests.HTTPError as e:
        return jsonify({"error": e.response.text}), e.response.status_code

    transactions = response.json()["data"]["transactions"]
    return jsonify({"count": len(transactions), "transactions": transactions}), 200


@app.post("/transactions")
@app.post("/transactions/<default_account_key>")
def post_transactions(default_account_key: str = "checking"):
    budget_id = _budget_from_args()
    if not budget_id:
        return jsonify({"error": INVALID_BUDGET_ERROR}), 400

    body = request.get_json(silent=True)

    if not isinstance(body, list) or len(body) == 0:
        return jsonify({"error": "Body must be a non-empty JSON array"}), 400

    transactions = []
    for i, item in enumerate(body):
        transaction, error = _validate_item(item, i, default_account_key)
        if error:
            return jsonify({"error": error}), 400
        transactions.append(transaction)

    payload = {"transactions": transactions}

    try:
        response = requests.post(
            f"{BASE_URL}/budgets/{budget_id}/transactions",
            headers=YNAB_HEADERS,
            json=payload,
        )
        response.raise_for_status()
    except requests.HTTPError as e:
        return jsonify({"error": e.response.text}), e.response.status_code

    created = response.json()["data"]["transactions"]
    return jsonify({"created": len(created), "transactions": created}), 201


if __name__ == "__main__":
    app.run(debug=True, port=5001)
