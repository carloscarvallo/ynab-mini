import json
import os
import unittest
from unittest.mock import MagicMock, patch

import requests

os.environ.setdefault("YNAB_ACCOUNT_ID", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
os.environ.setdefault("YNAB_REVOLUT_CC_ACCOUNT_ID", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")

from api import ACCOUNT_MAP, ACCOUNT_ID, REVOLUT_CC_ACCOUNT_ID, app


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
    def test_memo_is_always_from_script(self, mock_post):
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


if __name__ == "__main__":
    unittest.main()
