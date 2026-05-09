import json
import os
from datetime import date, datetime, timezone

import requests
from dotenv import load_dotenv
from flask import Blueprint, jsonify, request

load_dotenv()

BASE_URL = "https://api.ynab.com/v1"
EXPORT_FILE = "transactions_export.json"
ACCOUNT_MAP_FILE = "account_map.json"


def _get_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.getenv('YNAB_API_TOKEN')}"}


def _load_account_id_map() -> dict[str, str] | None:
    try:
        with open(ACCOUNT_MAP_FILE) as f:
            data = json.load(f)
    except FileNotFoundError:
        return None
    except json.JSONDecodeError as e:
        raise ValueError(f"Malformed {ACCOUNT_MAP_FILE}: {e}") from e
    return {entry["source"]: entry["destination"] for entry in data.get("accounts", [])}

_FIELDS_TO_STRIP = {
    "id",
    "transfer_account_id",
    "transfer_transaction_id",
    "matched_transaction_id",
    "import_id",
    "import_payee_name",
    "import_payee_name_original",
    "deleted",
    "subtransactions",
    "flag_color",
    "flag_name",
    "debt_transaction_type",
}

migrate_bp = Blueprint("migrate", __name__)


def _clean_transaction(txn: dict) -> dict:
    return {k: v for k, v in txn.items() if k not in _FIELDS_TO_STRIP}


@migrate_bp.get("/migrate/download")
def download_transactions():
    budget_id = os.getenv("YNAB_BUDGET_ID", "last-used")
    source_budget = request.args.get(
        "source_budget", os.getenv("YNAB_SOURCE_BUDGET_ID", budget_id)
    )
    since = request.args.get("since", date.today().replace(day=1).isoformat())

    try:
        response = requests.get(
            f"{BASE_URL}/budgets/{source_budget}/transactions",
            headers=_get_headers(),
            params={"since_date": since},
        )
        response.raise_for_status()
    except requests.HTTPError as e:
        return jsonify({"error": e.response.text}), e.response.status_code

    transactions = response.json()["data"]["transactions"]

    export = {
        "source_budget_id": source_budget,
        "since_date": since,
        "downloaded_at": datetime.now(timezone.utc).isoformat(),
        "transactions": transactions,
    }

    with open(EXPORT_FILE, "w") as f:
        json.dump(export, f, indent=2)

    return jsonify({"count": len(transactions), "file": EXPORT_FILE}), 200


@migrate_bp.post("/migrate/push")
def push_transactions():
    dest_budget = request.args.get("dest_budget", os.getenv("YNAB_DEST_BUDGET_ID", ""))
    if not dest_budget:
        return jsonify({"error": "dest_budget is required (query param or YNAB_DEST_BUDGET_ID env var)"}), 400

    try:
        with open(EXPORT_FILE) as f:
            export = json.load(f)
    except FileNotFoundError:
        return jsonify({"error": f"Export file '{EXPORT_FILE}' not found. Run GET /migrate/download first."}), 400
    except json.JSONDecodeError as e:
        return jsonify({"error": f"Malformed export file: {e}"}), 400

    raw_transactions: list[dict] = export.get("transactions", [])

    mapped: list[dict] = []
    skipped: list[dict] = []

    try:
        account_id_map = _load_account_id_map()
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    if account_id_map is None:
        return jsonify({"error": f"Account map file '{ACCOUNT_MAP_FILE}' not found. Copy account_map.example.json to account_map.json and fill in your account IDs."}), 400

    for txn in raw_transactions:
        src_account_id = txn.get("account_id", "")
        dest_account_id = account_id_map.get(src_account_id)
        if not dest_account_id:
            skipped.append({"id": txn.get("id"), "account_id": src_account_id})
            continue
        cleaned = _clean_transaction(txn)
        cleaned["account_id"] = dest_account_id
        mapped.append(cleaned)

    if not mapped:
        return jsonify({
            "created": 0,
            "transactions": [],
            "skipped": skipped,
            "warning": f"No transactions were mapped. Check {ACCOUNT_MAP_FILE}.",
        }), 200

    try:
        response = requests.post(
            f"{BASE_URL}/budgets/{dest_budget}/transactions",
            headers=_get_headers(),
            json={"transactions": mapped},
        )
        response.raise_for_status()
    except requests.HTTPError as e:
        return jsonify({"error": e.response.text}), e.response.status_code

    created = response.json()["data"]["transactions"]
    return jsonify({
        "created": len(created),
        "transactions": created,
        "skipped": skipped,
    }), 201
