import unittest
from unittest.mock import MagicMock, patch

import requests

from api import app


FAKE_MONTH_DATA = {
    "month": "2026-05-01",
    "income": 3000000,
    "budgeted": 2500000,
    "activity": -1200000,
    "to_be_budgeted": 500000,
    "categories": [
        {
            "id": "cat-1",
            "category_group_id": "grp-1",
            "category_group_name": "Frequent",
            "name": "Groceries",
            "budgeted": 500000,
            "activity": -300000,
            "balance": 200000,
            "hidden": False,
            "deleted": False,
        },
        {
            "id": "cat-2",
            "category_group_id": "grp-1",
            "category_group_name": "Frequent",
            "name": "Transportation",
            "budgeted": 200000,
            "activity": -150000,
            "balance": 50000,
            "hidden": False,
            "deleted": False,
        },
        {
            "id": "cat-3",
            "category_group_id": "grp-2",
            "category_group_name": "Non-Monthly",
            "name": "Car Maintenance",
            "budgeted": 100000,
            "activity": 0,
            "balance": 100000,
            "hidden": False,
            "deleted": False,
        },
        {
            "id": "cat-hidden",
            "category_group_id": "grp-2",
            "category_group_name": "Non-Monthly",
            "name": "Hidden Cat",
            "budgeted": 0,
            "activity": 0,
            "balance": 0,
            "hidden": True,
            "deleted": False,
        },
    ],
}


class TestGetBudget(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def _mock_fetch(self, month_data=None):
        data = month_data or FAKE_MONTH_DATA
        return MagicMock(
            status_code=200,
            json=lambda: {"data": {"month": data}},
            raise_for_status=lambda: None,
        )

    @patch("budget.requests.get")
    def test_get_budget_returns_200(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        response = self.client.get("/budget")
        self.assertEqual(response.status_code, 200)

    @patch("budget.requests.get")
    def test_get_budget_top_level_fields(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        data = self.client.get("/budget").get_json()
        self.assertEqual(data["month"], "2026-05-01")
        self.assertEqual(data["income"], 3000.0)
        self.assertEqual(data["budgeted"], 2500.0)
        self.assertEqual(data["activity"], -1200.0)
        self.assertEqual(data["to_be_budgeted"], 500.0)

    @patch("budget.requests.get")
    def test_groups_are_grouped_correctly(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        data = self.client.get("/budget").get_json()
        group_names = [g["name"] for g in data["groups"]]
        self.assertIn("Frequent", group_names)
        self.assertIn("Non-Monthly", group_names)
        self.assertEqual(len(data["groups"]), 2)

    @patch("budget.requests.get")
    def test_frequent_group_has_two_categories(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        data = self.client.get("/budget").get_json()
        frequent = next(g for g in data["groups"] if g["name"] == "Frequent")
        self.assertEqual(len(frequent["categories"]), 2)

    @patch("budget.requests.get")
    def test_hidden_categories_excluded(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        data = self.client.get("/budget").get_json()
        all_cats = [c for g in data["groups"] for c in g["categories"]]
        names = [c["name"] for c in all_cats]
        self.assertNotIn("Hidden Cat", names)

    @patch("budget.requests.get")
    def test_milliunits_converted_to_float(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        data = self.client.get("/budget").get_json()
        frequent = next(g for g in data["groups"] if g["name"] == "Frequent")
        groceries = next(c for c in frequent["categories"] if c["name"] == "Groceries")
        self.assertEqual(groceries["budgeted"], 500.0)
        self.assertEqual(groceries["activity"], -300.0)
        self.assertEqual(groceries["balance"], 200.0)

    @patch("budget.requests.get")
    def test_group_totals_summed(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        data = self.client.get("/budget").get_json()
        frequent = next(g for g in data["groups"] if g["name"] == "Frequent")
        self.assertEqual(frequent["budgeted"], 700.0)
        self.assertEqual(frequent["activity"], -450.0)
        self.assertEqual(frequent["balance"], 250.0)

    @patch("budget.requests.get")
    def test_custom_budget_id_in_url(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        custom_id = "abc-budget-uuid-123"
        self.client.get(f"/budget/{custom_id}")
        url = mock_get.call_args.args[0]
        self.assertIn(custom_id, url)

    @patch("budget.requests.get")
    def test_month_param_forwarded(self, mock_get):
        mock_get.return_value = self._mock_fetch()
        self.client.get("/budget?month=2026-03")
        url = mock_get.call_args.args[0]
        self.assertIn("2026-03-01", url)

    def test_invalid_month_format_returns_400(self):
        response = self.client.get("/budget?month=not-a-date")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid month format", response.get_json()["error"])

    @patch("budget.requests.get")
    def test_ynab_401_forwarded(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.raise_for_status.side_effect = requests.HTTPError(response=mock_response)
        mock_get.return_value = mock_response

        response = self.client.get("/budget")
        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
