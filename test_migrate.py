import json
import os
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import requests

os.environ.setdefault("YNAB_ACCOUNT_ID", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa")
os.environ.setdefault("YNAB_REVOLUT_CC_ACCOUNT_ID", "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb")
os.environ["YNAB_SOURCE_BUDGET_ID"] = "source-budget-uuid"
os.environ["YNAB_DEST_BUDGET_ID"] = "dest-budget-uuid"
os.environ["YNAB_ACCOUNT_ID_MAP"] = "src-acct-1111:dst-acct-aaaa,src-acct-2222:dst-acct-bbbb"

from api import app
import migrate


FAKE_TRANSACTIONS = [
    {
        "id": "txn-1",
        "account_id": "src-acct-1111",
        "account_name": "Checking",
        "date": "2026-05-01",
        "amount": -15000,
        "memo": "Coffee",
        "payee_name": "Cafe",
        "payee_id": "pay-1",
        "category_id": "cat-1",
        "category_name": "Food",
        "cleared": "cleared",
        "approved": True,
        "flag_color": None,
        "flag_name": None,
        "transfer_account_id": None,
        "transfer_transaction_id": None,
        "matched_transaction_id": None,
        "import_id": None,
        "import_payee_name": None,
        "import_payee_name_original": None,
        "deleted": False,
        "subtransactions": [],
        "debt_transaction_type": None,
    },
    {
        "id": "txn-2",
        "account_id": "src-acct-2222",
        "account_name": "CC",
        "date": "2026-05-02",
        "amount": -30000,
        "memo": "Groceries",
        "payee_name": "Supermarket",
        "payee_id": "pay-2",
        "category_id": "cat-2",
        "category_name": "Food",
        "cleared": "cleared",
        "approved": True,
        "flag_color": None,
        "flag_name": None,
        "transfer_account_id": None,
        "transfer_transaction_id": None,
        "matched_transaction_id": None,
        "import_id": None,
        "import_payee_name": None,
        "import_payee_name_original": None,
        "deleted": False,
        "subtransactions": [],
        "debt_transaction_type": None,
    },
    {
        "id": "txn-3",
        "account_id": "src-acct-unmapped",
        "account_name": "Unknown",
        "date": "2026-05-03",
        "amount": -5000,
        "memo": None,
        "payee_name": "Mystery",
        "payee_id": "pay-3",
        "category_id": "cat-3",
        "category_name": "Other",
        "cleared": "cleared",
        "approved": True,
        "flag_color": None,
        "flag_name": None,
        "transfer_account_id": None,
        "transfer_transaction_id": None,
        "matched_transaction_id": None,
        "import_id": None,
        "import_payee_name": None,
        "import_payee_name_original": None,
        "deleted": False,
        "subtransactions": [],
        "debt_transaction_type": None,
    },
]


class BaseMigrateTestCase(unittest.TestCase):
    def setUp(self):
        app.config["TESTING"] = True
        self.client = app.test_client()
        self._orig_export = migrate.EXPORT_FILE
        self._tmpdir = tempfile.mkdtemp()
        migrate.EXPORT_FILE = os.path.join(self._tmpdir, "transactions_export.json")

    def tearDown(self):
        migrate.EXPORT_FILE = self._orig_export

    def _mock_get(self, transactions):
        return MagicMock(
            status_code=200,
            json=lambda: {"data": {"transactions": transactions}},
            raise_for_status=lambda: None,
        )

    def _mock_post(self, transactions):
        return MagicMock(
            status_code=201,
            json=lambda: {"data": {"transactions": transactions}},
            raise_for_status=lambda: None,
        )

    def _write_export(self, transactions=None, source_budget="source-budget-uuid", since="2026-05-01"):
        data = {
            "source_budget_id": source_budget,
            "since_date": since,
            "downloaded_at": "2026-05-09T12:00:00+00:00",
            "transactions": transactions if transactions is not None else FAKE_TRANSACTIONS,
        }
        with open(migrate.EXPORT_FILE, "w") as f:
            json.dump(data, f)


class TestDownload(BaseMigrateTestCase):
    @patch("migrate.requests.get")
    def test_download_returns_200_and_count(self, mock_get):
        mock_get.return_value = self._mock_get(FAKE_TRANSACTIONS[:2])

        response = self.client.get("/migrate/download")

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["count"], 2)
        self.assertIn("file", data)

    @patch("migrate.requests.get")
    def test_download_writes_json_file(self, mock_get):
        mock_get.return_value = self._mock_get(FAKE_TRANSACTIONS[:1])

        self.client.get("/migrate/download")

        with open(migrate.EXPORT_FILE) as f:
            export = json.load(f)

        self.assertIn("source_budget_id", export)
        self.assertIn("since_date", export)
        self.assertIn("downloaded_at", export)
        self.assertEqual(len(export["transactions"]), 1)
        self.assertEqual(export["transactions"][0]["id"], "txn-1")

    @patch("migrate.requests.get")
    def test_download_since_param_forwarded(self, mock_get):
        mock_get.return_value = self._mock_get([])

        self.client.get("/migrate/download?since=2026-01-01")

        params = mock_get.call_args.kwargs["params"]
        self.assertEqual(params["since_date"], "2026-01-01")

    @patch("migrate.requests.get")
    def test_download_source_budget_param_used(self, mock_get):
        mock_get.return_value = self._mock_get([])

        self.client.get("/migrate/download?source_budget=custom-budget-id")

        url = mock_get.call_args.args[0]
        self.assertIn("custom-budget-id", url)

    @patch("migrate.requests.get")
    def test_download_ynab_401_forwarded(self, mock_get):
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.raise_for_status.side_effect = requests.HTTPError(response=mock_response)
        mock_get.return_value = mock_response

        response = self.client.get("/migrate/download")

        self.assertEqual(response.status_code, 401)


class TestPush(BaseMigrateTestCase):
    @patch("migrate.requests.post")
    def test_push_remaps_accounts_and_posts(self, mock_post):
        self._write_export(FAKE_TRANSACTIONS)
        mock_post.return_value = self._mock_post([
            {"id": "new-1", "account_id": "dst-acct-aaaa", "amount": -15000},
            {"id": "new-2", "account_id": "dst-acct-bbbb", "amount": -30000},
        ])

        response = self.client.post("/migrate/push")

        self.assertEqual(response.status_code, 201)
        data = response.get_json()
        self.assertEqual(data["created"], 2)

    @patch("migrate.requests.post")
    def test_push_strips_server_assigned_fields(self, mock_post):
        self._write_export(FAKE_TRANSACTIONS[:1])
        mock_post.return_value = self._mock_post([{"id": "new-1", "amount": -15000}])

        self.client.post("/migrate/push")

        sent = mock_post.call_args.kwargs["json"]["transactions"]
        self.assertEqual(len(sent), 1)
        for field in ("id", "transfer_account_id", "import_id", "deleted", "subtransactions"):
            self.assertNotIn(field, sent[0])

    @patch("migrate.requests.post")
    def test_push_account_id_remapped(self, mock_post):
        self._write_export(FAKE_TRANSACTIONS[:1])
        mock_post.return_value = self._mock_post([{"id": "new-1", "amount": -15000}])

        self.client.post("/migrate/push")

        sent = mock_post.call_args.kwargs["json"]["transactions"]
        self.assertEqual(sent[0]["account_id"], "dst-acct-aaaa")

    @patch("migrate.requests.post")
    def test_push_skips_unmapped_accounts(self, mock_post):
        self._write_export(FAKE_TRANSACTIONS)
        mock_post.return_value = self._mock_post([
            {"id": "new-1", "amount": -15000},
            {"id": "new-2", "amount": -30000},
        ])

        response = self.client.post("/migrate/push")

        data = response.get_json()
        self.assertEqual(len(data["skipped"]), 1)
        self.assertEqual(data["skipped"][0]["account_id"], "src-acct-unmapped")

    @patch("migrate.requests.post")
    def test_push_dest_budget_param_used(self, mock_post):
        self._write_export(FAKE_TRANSACTIONS[:1])
        mock_post.return_value = self._mock_post([{"id": "new-1", "amount": -15000}])

        self.client.post("/migrate/push?dest_budget=override-budget")

        url = mock_post.call_args.args[0]
        self.assertIn("override-budget", url)

    def test_push_missing_export_file_returns_400(self):
        response = self.client.post("/migrate/push")

        self.assertEqual(response.status_code, 400)
        self.assertIn("not found", response.get_json()["error"])

    def test_push_missing_dest_budget_returns_400(self):
        self._write_export(FAKE_TRANSACTIONS[:1])
        orig = os.environ.pop("YNAB_DEST_BUDGET_ID", None)

        response = self.client.post("/migrate/push")

        if orig is not None:
            os.environ["YNAB_DEST_BUDGET_ID"] = orig
        self.assertEqual(response.status_code, 400)
        self.assertIn("dest_budget", response.get_json()["error"])

    def test_push_all_unmapped_returns_200_with_warning(self):
        self._write_export([FAKE_TRANSACTIONS[2]])

        response = self.client.post("/migrate/push")

        self.assertEqual(response.status_code, 200)
        data = response.get_json()
        self.assertEqual(data["created"], 0)
        self.assertIn("warning", data)

    @patch("migrate.requests.post")
    def test_push_ynab_401_forwarded(self, mock_post):
        self._write_export(FAKE_TRANSACTIONS[:1])
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Unauthorized"
        mock_response.raise_for_status.side_effect = requests.HTTPError(response=mock_response)
        mock_post.return_value = mock_response

        response = self.client.post("/migrate/push")

        self.assertEqual(response.status_code, 401)


if __name__ == "__main__":
    unittest.main()
