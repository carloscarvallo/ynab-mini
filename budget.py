import os
from collections import defaultdict
from datetime import date

import requests
from dotenv import load_dotenv
from flask import Blueprint, jsonify, request

load_dotenv()

API_TOKEN = os.getenv("YNAB_API_TOKEN")
BUDGET_ID = os.getenv("YNAB_BUDGET_ID", "last-used")
BASE_URL = "https://api.ynab.com/v1"

YNAB_HEADERS = {"Authorization": f"Bearer {API_TOKEN}"}

budget_bp = Blueprint("budget", __name__)


def _milliunits_to_float(milliunits: int) -> float:
    return round(milliunits / 1000, 2)


def _fetch_month(month: str, budget_id: str = BUDGET_ID) -> dict:
    response = requests.get(
        f"{BASE_URL}/budgets/{budget_id}/months/{month}",
        headers=YNAB_HEADERS,
    )
    response.raise_for_status()
    return response.json()["data"]["month"]


def _build_plan(month_data: dict) -> dict:
    groups: dict[str, dict] = defaultdict(lambda: {"name": "", "budgeted": 0.0, "activity": 0.0, "balance": 0.0, "categories": []})

    for cat in month_data.get("categories", []):
        if cat.get("hidden") or cat.get("deleted"):
            continue
        group_id = cat["category_group_id"]
        group = groups[group_id]
        group["name"] = cat["category_group_name"]

        entry = {
            "id": cat["id"],
            "name": cat["name"],
            "budgeted": _milliunits_to_float(cat["budgeted"]),
            "activity": _milliunits_to_float(cat["activity"]),
            "balance": _milliunits_to_float(cat["balance"]),
        }
        group["categories"].append(entry)
        group["budgeted"] = round(group["budgeted"] + entry["budgeted"], 2)
        group["activity"] = round(group["activity"] + entry["activity"], 2)
        group["balance"] = round(group["balance"] + entry["balance"], 2)

    return {
        "month": month_data["month"],
        "income": _milliunits_to_float(month_data["income"]),
        "budgeted": _milliunits_to_float(month_data["budgeted"]),
        "activity": _milliunits_to_float(month_data["activity"]),
        "to_be_budgeted": _milliunits_to_float(month_data["to_be_budgeted"]),
        "groups": list(groups.values()),
    }


@budget_bp.get("/budget")
@budget_bp.get("/budget/<budget_id>")
def get_budget(budget_id: str = BUDGET_ID):
    month = request.args.get("month", "current")

    if month != "current":
        try:
            parsed = date.fromisoformat(f"{month}-01")
            month = parsed.strftime("%Y-%m-01")
        except ValueError:
            return jsonify({"error": "Invalid month format. Use YYYY-MM (e.g. 2026-05)"}), 400

    try:
        month_data = _fetch_month(month, budget_id)
    except requests.HTTPError as e:
        return jsonify({"error": e.response.text}), e.response.status_code

    return jsonify(_build_plan(month_data)), 200
