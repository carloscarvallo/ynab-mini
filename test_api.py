import json
import os
import unittest
from datetime import date
from unittest.mock import MagicMock, patch

import requests

os.environ.setdefault("YNAB_ACCOUNT_ID", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
os.environ.setdefault("YNAB_REVOLUT_CC_ACCOUNT_ID", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

from api import ACCOUNT_MAP, ACCOUNT_ID, BASE_URL, BUDGET_ID, REVOLUT_CC_ACCOUNT_ID, app


class BaseTestCase(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()

    def _post(self, body, account_key=None):
        url = f"/transactions/{account_key}" if account_key else "/transactions"
        return self.client.post(url, data=json.dumps(body), content_type="application/json")

    def _get(self, account_key=None, since=None):
        url = f"/transactions/{account_key}" if account_key else "/transactions"
        if since:
            url += f"?since={since}"
        return self.client.get(url)

    def _mock_post(self, transactions):
        return MagicMock(
            status_code=201,
            json=lambda: {"data": {"transactions": transactions}},
            raise_for_status=lambda: None,
        )

    def _mock_get(self, transactions):
        return MagicMock(
            status_code=200,
            json=lambda: {"data": {"transactions": transactions}},
            raise_for_status=lambda: None,
        )


class TestPostValidation(BaseTestCase):
    # --- Input validation ---

    def test_empty_body_returns_400(self):
        response = self._post([])
        self.assertEqual(response.status_code, 400)
        self.assertIn("error", response.get_json())

    def test_non_array_body_returns_400(self):
        response = self._post({"amount": 10.0})
        self.assertEqual(response.status_code, 400)

    def test_missing_amount_returns_400(self):
        response = self._post([{"memo": "oops"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("missing 'amount'", response.get_json()["error"])

    def test_non_numeric_amount_returns_400(self):
        response = self._post([{"amount": "lots"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("must be a number", response.get_json()["error"])

    def test_second_item_missing_amount_returns_400(self):
        response = self._post([{"amount": 10.0}, {"memo": "no amount"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("index 1", response.get_json()["error"])

    def test_invalid_account_in_body_returns_400(self):
        response = self._post([{"amount": 10.0, "account": "savings"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("unknown account", response.get_json()["error"])

    def test_invalid_account_in_url_returns_400(self):
        response = self._post([{"amount": 10.0}], account_key="savings")
        self.assertEqual(response.status_code, 400)
        self.assertIn("unknown account", response.get_json()["error"])


class TestPostCreate(BaseTestCase):
    # --- Successful creation ---

    @patch("api.requests.post")
    def test_single_transaction_created(self, mock_post):
        fake_txn = {"id": "abc-1", "amount": -15000, "memo": "from script", "date": "2026-04-24"}
        mock_post.return_value = self._mock_post([fake_txn])

        response = self._post([{"amount": -15.0}])

        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertEqual(data["created"], 1)
        self.assertEqual(data["transactions"][0]["id"], "abc-1")

    @patch("api.requests.post")
    def test_multiple_transactions_created(self, mock_post):
        fake_txns = [
            {"id": "abc-1", "amount": 15000, "memo": "from script", "date": "2026-04-24"},
            {"id": "abc-2", "amount": 12000, "memo": "from script", "date": "2026-04-24"},
        ]
        mock_post.return_value = self._mock_post(fake_txns)

        response = self._post([{"amount": 15.0}, {"amount": 12.0}])

        self.assertEqual(response.status_code, 201)
        self.assertEqual(response.get_json()["created"], 2)

    @patch("api.requests.post")
    def test_amount_converted_to_milliunits(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x", "amount": -9990, "memo": "from script", "date": "2026-04-24"}])

        self._post([{"amount": -9.99}])

        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["amount"], -9990)

    @patch("api.requests.post")
    def test_memo_defaults_to_from_script(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x", "amount": 5000, "memo": "from script", "date": "2026-04-24"}])

        self._post([{"amount": 5.0}])

        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["memo"], "from script")

    @patch("api.requests.post")
    def test_url_account_key_sets_default_account(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x", "amount": -5000, "memo": "from script", "date": "2026-04-24"}])

        self._post([{"amount": -5.0}], account_key="cc")

        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["account_id"], REVOLUT_CC_ACCOUNT_ID)

    @patch("api.requests.post")
    def test_body_account_overrides_url_default(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x", "amount": -5000, "memo": "from script", "date": "2026-04-24"}])

        self._post([{"amount": -5.0, "account": "checking"}], account_key="cc")

        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["account_id"], ACCOUNT_ID)

    @patch("api.requests.post")
    def test_mixed_accounts_in_same_request(self, mock_post):
        mock_post.return_value = self._mock_post([
            {"id": "x1", "amount": -5000, "memo": "from script", "date": "2026-04-24"},
            {"id": "x2", "amount": -3000, "memo": "from script", "date": "2026-04-24"},
        ])

        self._post([{"amount": -5.0}, {"amount": -3.0, "account": "cc"}])

        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["account_id"], ACCOUNT_ID)
        self.assertEqual(sent["transactions"][1]["account_id"], REVOLUT_CC_ACCOUNT_ID)

    @patch("api.requests.post")
    def test_raw_uuid_in_url_is_accepted(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x", "amount": -5000, "memo": "from script", "date": "2026-05-06"}])
        some_uuid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"

        response = self._post([{"amount": -5.0}], account_key=some_uuid)

        self.assertEqual(response.status_code, 201)
        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["account_id"], some_uuid)

    @patch("api.requests.post")
    def test_raw_uuid_in_body_item_is_accepted(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x", "amount": -5000, "memo": "from script", "date": "2026-05-06"}])
        some_uuid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"

        response = self._post([{"amount": -5.0, "account": some_uuid}])

        self.assertEqual(response.status_code, 201)
        sent = mock_post.call_args.kwargs["json"]
        self.assertEqual(sent["transactions"][0]["account_id"], some_uuid)

    @patch("api.requests.post")
    def test_ynab_401_forwarded(self, mock_post):
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.raise_for_status.side_effect = requests.HTTPError(response=mock_response)
        mock_post.return_value = mock_response

        response = self._post([{"amount": 10.0}])

        self.assertEqual(response.status_code, 401)


class TestGetTransactions(BaseTestCase):
    # --- GET /transactions ---

    @patch("api.requests.get")
    def test_get_defaults_to_checking(self, mock_get):
        mock_get.return_value = self._mock_get([])

        self._get()

        params = mock_get.call_args.kwargs["params"]
        self.assertEqual(params["account_id"], ACCOUNT_ID)

    @patch("api.requests.get")
    def test_get_cc_uses_cc_account(self, mock_get):
        mock_get.return_value = self._mock_get([])

        self._get(account_key="cc")

        params = mock_get.call_args.kwargs["params"]
        self.assertEqual(params["account_id"], REVOLUT_CC_ACCOUNT_ID)

    @patch("api.requests.get")
    def test_get_returns_transactions(self, mock_get):
        fake_txns = [{"id": "t1", "amount": -5000, "date": "2026-05-01"}]
        mock_get.return_value = self._mock_get(fake_txns)

        response = self._get(account_key="checking")

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["transactions"][0]["id"], "t1")

    @patch("api.requests.get")
    def test_get_since_param_forwarded(self, mock_get):
        mock_get.return_value = self._mock_get([])

        self._get(account_key="checking", since="2026-01-01")

        params = mock_get.call_args.kwargs["params"]
        self.assertEqual(params["since_date"], "2026-01-01")

    def test_get_invalid_account_returns_400(self):
        response = self._get(account_key="savings")
        self.assertEqual(response.status_code, 400)
        self.assertIn("Unknown account", response.get_json()["error"])

    @patch("api.requests.get")
    def test_get_raw_uuid_in_url_is_accepted(self, mock_get):
        mock_get.return_value = self._mock_get([])
        some_uuid = "e11f0d7b-5969-49b7-8df8-491b8e160eec"

        response = self._get(account_key=some_uuid)

        self.assertEqual(response.status_code, 200)
        params = mock_get.call_args.kwargs["params"]
        self.assertEqual(params["account_id"], some_uuid)

    @patch("api.requests.get")
    def test_get_ynab_401_forwarded(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.raise_for_status.side_effect = requests.HTTPError(response=mock_response)
        mock_get.return_value = mock_response

        response = self._get(account_key="cc")

        self.assertEqual(response.status_code, 401)


class TestPostOptionalFields(BaseTestCase):
    # --- date / payee_name / memo overrides ---

    def _sent_txn(self, mock_post, index=0):
        return mock_post.call_args.kwargs["json"]["transactions"][index]

    @patch("api.requests.post")
    def test_date_defaults_to_today(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -5.0}])

        self.assertEqual(self._sent_txn(mock_post)["date"], date.today().isoformat())

    @patch("api.requests.post")
    def test_explicit_date_is_forwarded(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -50.49, "date": "2026-08-27"}])

        self.assertEqual(self._sent_txn(mock_post)["date"], "2026-08-27")

    def test_malformed_date_returns_400(self):
        response = self._post([{"amount": -5.0, "date": "27/08/2026"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("YYYY-MM-DD", response.get_json()["error"])

    def test_impossible_date_returns_400(self):
        response = self._post([{"amount": -5.0, "date": "2026-02-31"}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("YYYY-MM-DD", response.get_json()["error"])

    def test_non_string_date_returns_400(self):
        response = self._post([{"amount": -5.0, "date": 20260827}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("YYYY-MM-DD", response.get_json()["error"])

    @patch("api.requests.post")
    def test_payee_name_is_forwarded(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -50.49, "payee_name": "Deliveroo"}])

        self.assertEqual(self._sent_txn(mock_post)["payee_name"], "Deliveroo")

    @patch("api.requests.post")
    def test_payee_name_omitted_when_not_given(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -5.0}])

        self.assertNotIn("payee_name", self._sent_txn(mock_post))

    def test_non_string_payee_name_returns_400(self):
        response = self._post([{"amount": -5.0, "payee_name": 42}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("'payee_name' must be a string", response.get_json()["error"])

    @patch("api.requests.post")
    def test_explicit_memo_overrides_default(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -5.0, "memo": "Revolut import"}])

        self.assertEqual(self._sent_txn(mock_post)["memo"], "Revolut import")

    def test_non_string_memo_returns_400(self):
        response = self._post([{"amount": -5.0, "memo": ["nope"]}])
        self.assertEqual(response.status_code, 400)
        self.assertIn("'memo' must be a string", response.get_json()["error"])

    def test_non_object_item_returns_400(self):
        response = self._post([5])
        self.assertEqual(response.status_code, 400)
        self.assertIn("must be a JSON object", response.get_json()["error"])

    @patch("api.requests.post")
    def test_all_optional_fields_together(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{
            "amount": -62.0,
            "date": "2026-08-26",
            "payee_name": "SANA Hotels",
            "memo": "Lisbon trip",
            "account": "cc",
        }])

        sent = self._sent_txn(mock_post)
        self.assertEqual(sent["date"], "2026-08-26")
        self.assertEqual(sent["payee_name"], "SANA Hotels")
        self.assertEqual(sent["memo"], "Lisbon trip")
        self.assertEqual(sent["amount"], -62000)
        self.assertEqual(sent["account_id"], REVOLUT_CC_ACCOUNT_ID)


class TestBudgetSelection(BaseTestCase):
    # --- ?budget= query param ---

    OTHER_BUDGET = "cccccccc-cccc-cccc-cccc-cccccccccccc"

    @patch("api.requests.get")
    def test_get_defaults_to_env_budget(self, mock_get):
        mock_get.return_value = self._mock_get([])

        self._get()

        self.assertEqual(mock_get.call_args.args[0], f"{BASE_URL}/budgets/{BUDGET_ID}/transactions")

    @patch("api.requests.get")
    def test_get_budget_query_param_overrides_default(self, mock_get):
        mock_get.return_value = self._mock_get([])

        response = self.client.get(f"/transactions?budget={self.OTHER_BUDGET}")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(mock_get.call_args.args[0], f"{BASE_URL}/budgets/{self.OTHER_BUDGET}/transactions")

    @patch("api.requests.post")
    def test_post_defaults_to_env_budget(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -5.0}])

        self.assertEqual(mock_post.call_args.args[0], f"{BASE_URL}/budgets/{BUDGET_ID}/transactions")

    @patch("api.requests.post")
    def test_post_budget_query_param_overrides_default(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        response = self.client.post(
            f"/transactions/cc?budget={self.OTHER_BUDGET}",
            data=json.dumps([{"amount": -5.0}]),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 201)
        self.assertEqual(mock_post.call_args.args[0], f"{BASE_URL}/budgets/{self.OTHER_BUDGET}/transactions")

    @patch("api.requests.get")
    def test_last_used_budget_is_accepted(self, mock_get):
        mock_get.return_value = self._mock_get([])

        response = self.client.get("/transactions?budget=last-used")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(mock_get.call_args.args[0], f"{BASE_URL}/budgets/last-used/transactions")

    @patch("api.requests.get")
    def test_get_invalid_budget_returns_400(self, mock_get):
        response = self.client.get("/transactions?budget=../user")

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid budget", response.get_json()["error"])
        mock_get.assert_not_called()

    @patch("api.requests.post")
    def test_post_invalid_budget_returns_400(self, mock_post):
        response = self.client.post(
            "/transactions?budget=not-a-uuid",
            data=json.dumps([{"amount": -5.0}]),
            content_type="application/json",
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("Invalid budget", response.get_json()["error"])
        mock_post.assert_not_called()


class TestMilliunitRounding(BaseTestCase):
    # --- float-to-milliunit conversion must not truncate ---

    @patch("api.requests.post")
    def test_amount_with_float_representation_error_rounds_correctly(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -50.49}])

        sent = mock_post.call_args.kwargs["json"]["transactions"][0]
        self.assertEqual(sent["amount"], -50490)

    @patch("api.requests.post")
    def test_several_cent_amounts_round_correctly(self, mock_post):
        mock_post.return_value = self._mock_post([{"id": "x"}])

        self._post([{"amount": -39.84}, {"amount": -38.40}, {"amount": -70.28}, {"amount": -56.90}])

        sent = mock_post.call_args.kwargs["json"]["transactions"]
        self.assertEqual([t["amount"] for t in sent], [-39840, -38400, -70280, -56900])


if __name__ == "__main__":
    unittest.main()
