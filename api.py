import os
import re
from datetime import date

import requests
from dotenv import load_dotenv
from flask import Flask, jsonify, request

from budget import budget_bp

load_dotenv()

app = Flask(__name__)
app.register_blueprint(budget_bp)

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


def _build_transaction(amount: float, account_id: str = ACCOUNT_ID) -> dict:
    return {
        "account_id": account_id,
        "date": date.today().isoformat(),
        "amount": int(amount * 1000),
        "memo": "from script",
        "approved": True,
    }


@app.get("/transactions")
@app.get("/transactions/<account_key>")
def get_transactions(account_key: str = "checking"):
    account_key = account_key.lower()
    account_id = _resolve_account(account_key)
    if not account_id:
        return jsonify({"error": f"Unknown account '{account_key}'. Use a friendly name {list(ACCOUNT_MAP.keys())} or a valid UUID."}), 400

    since_date = request.args.get("since", date.today().replace(day=1).isoformat())

    try:
        response = requests.get(
            f"{BASE_URL}/budgets/{BUDGET_ID}/transactions",
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
    body = request.get_json(silent=True)

    if not isinstance(body, list) or len(body) == 0:
        return jsonify({"error": "Body must be a non-empty JSON array"}), 400

    transactions = []
    for i, item in enumerate(body):
        if "amount" not in item:
            return jsonify({"error": f"Item at index {i} is missing 'amount'"}), 400
        if not isinstance(item["amount"], (int, float)):
            return jsonify({"error": f"Item at index {i}: 'amount' must be a number"}), 400
        account_key = item.get("account", default_account_key).lower()
        account_id = _resolve_account(account_key)
        if not account_id:
            return jsonify({"error": f"Item at index {i}: unknown account '{account_key}'. Use a friendly name {list(ACCOUNT_MAP.keys())} or a valid UUID."}), 400
        transactions.append(_build_transaction(item["amount"], account_id))

    payload = {"transactions": transactions}

    try:
        response = requests.post(
            f"{BASE_URL}/budgets/{BUDGET_ID}/transactions",
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
