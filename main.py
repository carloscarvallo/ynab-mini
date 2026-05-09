import os
import sys
import requests
from datetime import date
from dotenv import load_dotenv

load_dotenv()

API_TOKEN = os.getenv("YNAB_API_TOKEN")
BUDGET_ID = os.getenv("YNAB_BUDGET_ID", "last-used")
BASE_URL = "https://api.ynab.com/v1"

HEADERS = {"Authorization": f"Bearer {API_TOKEN}"}
ACCOUNT_ID = os.getenv("YNAB_ACCOUNT_ID", "")


def milliunits_to_currency(milliunits: int) -> str:
    return f"{milliunits / 1000:,.2f}"


def get_transactions(since_date: str | None = None) -> list[dict]:
    url = f"{BASE_URL}/budgets/{BUDGET_ID}/transactions"
    params = {}
    if since_date:
        params["since_date"] = since_date
    response = requests.get(url, headers=HEADERS, params=params)
    response.raise_for_status()
    return response.json()["data"]["transactions"]


def print_transactions(transactions: list[dict]) -> None:
    if not transactions:
        print("No transactions found.")
        return

    print(f"\n{'DATE':<12} {'PAYEE':<35} {'CATEGORY':<30} {'AMOUNT':>12}")
    print("-" * 92)

    for t in sorted(transactions, key=lambda x: x["date"], reverse=True):
        date_str = t.get("date", "")
        payee = (t.get("payee_name") or "")[:34]
        category = (t.get("category_name") or "")[:29]
        amount = milliunits_to_currency(t.get("amount", 0))
        print(f"{date_str:<12} {payee:<35} {category:<30} {amount:>12}")

    print(f"\nTotal transactions: {len(transactions)}")


def create_transaction(amount: float) -> dict:
    url = f"{BASE_URL}/budgets/{BUDGET_ID}/transactions"
    payload = {
        "transaction": {
            "account_id": ACCOUNT_ID,
            "date": date.today().isoformat(),
            "amount": int(amount * 1000),
            "memo": "from script",
            "approved": True,
        }
    }
    response = requests.post(url, headers=HEADERS, json=payload)
    response.raise_for_status()
    return response.json()["data"]["transaction"]


def main() -> None:
    if not API_TOKEN or API_TOKEN == "your_personal_access_token_here":
        print("Error: Set YNAB_API_TOKEN in your .env file.")
        print("Get a token at: https://app.ynab.com/settings/developer")
        return

    if len(sys.argv) == 2:
        try:
            amount = float(sys.argv[1])
            t = create_transaction(amount)
            print(f"Created transaction: {t['date']}  {amount:+.2f}  memo: {t['memo']}  id: {t['id']}")
        except requests.HTTPError as e:
            print(f"API error: {e.response.status_code} - {e.response.text}")
    else:
        first_day_of_month = date.today().replace(day=1).isoformat()
        print(f"Fetching transactions since {first_day_of_month}...")
        try:
            transactions = get_transactions(since_date=first_day_of_month)
            print_transactions(transactions)
        except requests.HTTPError as e:
            print(f"API error: {e.response.status_code} - {e.response.text}")


if __name__ == "__main__":
    main()
