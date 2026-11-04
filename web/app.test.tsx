import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import {
  type AccountsConfig,
  buildTransactionsUrl,
  checkSelection,
  createAppServer,
  expandHome,
  formatAmount,
  loadAccountsConfig,
  readTransactionsFile,
  renderPage,
  submitTransactions,
} from "./app.tsx";

const ACCOUNT = "b5cdc269-13bb-4c3d-b51d-604a453978f4";
const BUDGET = "7fe20706-e3ee-40c9-8e27-20dcc0f79485";
const OTHER_BUDGET = "11111111-2222-3333-4444-555555555555";
const OTHER_ACCOUNT = "66666666-7777-8888-9999-000000000000";
const CONFIG: AccountsConfig = {
  budgets: [
    {
      label: "Personal",
      id: BUDGET,
      accounts: [
        { label: "Itau Checking", id: ACCOUNT },
        { label: "Revolut", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" },
      ],
    },
    { label: "Business", id: OTHER_BUDGET, accounts: [{ label: "Business Checking", id: OTHER_ACCOUNT }] },
  ],
};
const TXNS = [{ amount: 7200000, date: "2026-10-16", payee_name: "SPI", memo: "Ref 1" }];

async function writeTempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "ynab-web-"));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

describe("buildTransactionsUrl", () => {
  test("puts the account in the path and the budget in the query", () => {
    const url = buildTransactionsUrl("http://localhost:5001", ACCOUNT, BUDGET);
    assert.equal(url, `http://localhost:5001/transactions/${ACCOUNT}?budget=${BUDGET}`);
  });

  test("omits the budget query when the budget is blank", () => {
    const url = buildTransactionsUrl("http://localhost:5001", "cc", "  ");
    assert.equal(url, "http://localhost:5001/transactions/cc");
  });

  test("encodes the account segment", () => {
    const url = buildTransactionsUrl("http://localhost:5001", "a/b", "");
    assert.equal(url, "http://localhost:5001/transactions/a%2Fb");
  });
});

describe("expandHome", () => {
  test("expands a leading ~/ to the home directory", () => {
    assert.equal(expandHome("~/txns.json"), join(homedir(), "txns.json"));
  });

  test("leaves absolute paths unchanged", () => {
    assert.equal(expandHome("/private/tmp/txns.json"), "/private/tmp/txns.json");
  });
});

describe("readTransactionsFile", () => {
  test("returns the parsed array from a JSON file", async () => {
    const path = await writeTempFile("txns.json", JSON.stringify(TXNS));
    assert.deepEqual(await readTransactionsFile(path), TXNS);
  });

  test("throws a readable error when the file does not exist", async () => {
    await assert.rejects(readTransactionsFile("/nope/missing.json"), {
      message: "Cannot read file '/nope/missing.json'",
    });
  });

  test("throws when the file is not valid JSON", async () => {
    const path = await writeTempFile("bad.json", "{ not json");
    await assert.rejects(readTransactionsFile(path), { message: `File '${path}' is not valid JSON` });
  });

  test("throws when the JSON is not an array", async () => {
    const path = await writeTempFile("obj.json", '{"amount": 1}');
    await assert.rejects(readTransactionsFile(path), {
      message: `File '${path}' must contain a JSON array of transactions`,
    });
  });
});

type FetchCall = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("submitTransactions", () => {
  const API = "http://localhost:5001";

  test("posts the file contents to the API and returns the created transactions", async () => {
    const filePath = await writeTempFile("txns.json", JSON.stringify(TXNS));
    const created = [{ id: "t1", amount: 7200000 }];
    const { fetchImpl, calls } = fakeFetch(201, { created: 1, transactions: created });

    const result = await submitTransactions({ account: ACCOUNT, budget: BUDGET, filePath }, API, fetchImpl);

    assert.deepEqual(result, { ok: true, status: 201, transactions: created });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, `${API}/transactions/${ACCOUNT}?budget=${BUDGET}`);
    assert.equal(calls[0].init.method, "POST");
    assert.deepEqual(calls[0].init.headers, { "Content-Type": "application/json" });
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), TXNS);
  });

  test("forwards the API error message and status code", async () => {
    const filePath = await writeTempFile("txns.json", JSON.stringify(TXNS));
    const { fetchImpl } = fakeFetch(400, { error: "Invalid budget." });

    const result = await submitTransactions({ account: ACCOUNT, budget: "x", filePath }, API, fetchImpl);

    assert.deepEqual(result, { ok: false, status: 400, error: "Invalid budget." });
  });

  test("rejects a blank account without calling the API", async () => {
    const { fetchImpl, calls } = fakeFetch(201, {});

    const result = await submitTransactions({ account: " ", budget: "", filePath: "/x.json" }, API, fetchImpl);

    assert.deepEqual(result, { ok: false, error: "Account is required" });
    assert.equal(calls.length, 0);
  });

  test("rejects a blank file path without calling the API", async () => {
    const { fetchImpl, calls } = fakeFetch(201, {});

    const result = await submitTransactions({ account: ACCOUNT, budget: "", filePath: "" }, API, fetchImpl);

    assert.deepEqual(result, { ok: false, error: "File path is required" });
    assert.equal(calls.length, 0);
  });

  test("returns the file error without calling the API", async () => {
    const { fetchImpl, calls } = fakeFetch(201, {});

    const result = await submitTransactions({ account: ACCOUNT, budget: "", filePath: "/nope.json" }, API, fetchImpl);

    assert.deepEqual(result, { ok: false, error: "Cannot read file '/nope.json'" });
    assert.equal(calls.length, 0);
  });

  test("reports when the API cannot be reached", async () => {
    const filePath = await writeTempFile("txns.json", JSON.stringify(TXNS));
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;

    const result = await submitTransactions({ account: ACCOUNT, budget: "", filePath }, API, fetchImpl);

    assert.deepEqual(result, { ok: false, error: `Cannot reach the API at ${API}. Is it running?` });
  });
});

describe("formatAmount", () => {
  test("converts milliunits to a two-decimal currency string", () => {
    assert.equal(formatAmount(7200000), "7,200.00");
    assert.equal(formatAmount(-317747), "-317.75");
  });
});

function openingTag(html: string, start: RegExp): string {
  const index = html.search(start);
  assert.notEqual(index, -1, `no tag matching ${start}`);
  return html.slice(index, html.indexOf(">", index) + 1);
}

function between(html: string, start: string, end: string): string {
  const index = html.indexOf(start);
  assert.notEqual(index, -1, `no ${start}`);
  return html.slice(index, html.indexOf(end, index) + end.length);
}

describe("renderPage", () => {
  const EMPTY = { account: "", budget: "", filePath: "" };

  test("renders a doctype and a labelled form that posts to the server", () => {
    const html = renderPage({ config: CONFIG, values: EMPTY });

    const form = openingTag(html, /<form\b/);
    const budget = openingTag(html, /<select id="budget"/);
    const account = openingTag(html, /<select id="account"/);
    const filePath = openingTag(html, /<input id="filePath"/);

    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(form.includes('method="post"') && form.includes('action="/"'));
    assert.match(html, /<label for="budget">Budget<\/label>/);
    assert.ok(budget.includes('name="budget"') && budget.includes('required=""'));
    assert.match(html, /<label for="account">Account<\/label>/);
    assert.ok(account.includes('name="account"') && account.includes('required=""'));
    assert.match(html, /<label for="filePath">File path<\/label>/);
    assert.ok(filePath.includes('name="filePath"') && filePath.includes('required=""'));
    assert.match(html, /<button type="submit">Send transactions<\/button>/);
  });

  test("lists every budget from the config", () => {
    const budgets = between(renderPage({ config: CONFIG, values: EMPTY }), '<select id="budget"', "</select>");

    assert.match(budgets, new RegExp(`<option value="${BUDGET}"[^>]*>Personal</option>`));
    assert.match(budgets, new RegExp(`<option value="${OTHER_BUDGET}"[^>]*>Business</option>`));
  });

  test("shows only the first budget's accounts by default", () => {
    const accounts = between(renderPage({ config: CONFIG, values: EMPTY }), '<select id="account"', "</select>");

    assert.match(accounts, new RegExp(`<option value="${ACCOUNT}"[^>]*>Itau Checking</option>`));
    assert.match(accounts, />Revolut</);
    assert.doesNotMatch(accounts, /Business Checking/);
  });

  test("shows the accounts of the submitted budget and keeps the submitted values", () => {
    const values = { budget: OTHER_BUDGET, account: OTHER_ACCOUNT, filePath: "/tmp/t.json" };
    const html = renderPage({ config: CONFIG, values });
    const budgets = between(html, '<select id="budget"', "</select>");
    const accounts = between(html, '<select id="account"', "</select>");

    assert.match(budgets, new RegExp(`<option value="${OTHER_BUDGET}" selected="">`));
    assert.match(accounts, new RegExp(`<option value="${OTHER_ACCOUNT}" selected="">Business Checking</option>`));
    assert.doesNotMatch(accounts, /Itau Checking/);
    assert.match(html, /value="\/tmp\/t.json"/);
  });

  test("renders a template of account options per budget for the budget switcher", () => {
    const html = renderPage({ config: CONFIG, values: EMPTY });

    assert.match(between(html, `<template data-budget="${BUDGET}">`, "</template>"), /Itau Checking.*Revolut/);
    assert.match(between(html, `<template data-budget="${OTHER_BUDGET}">`, "</template>"), /Business Checking/);
    assert.match(html, /<script>[^<]*addEventListener\("change"/);
  });

  test("shows the config error instead of the form", () => {
    const html = renderPage({ configError: "Cannot read file 'web/accounts.json'", values: EMPTY });

    assert.match(html, /role="alert"/);
    assert.match(html, /Cannot read file &#x27;web\/accounts.json&#x27;/);
    assert.match(html, /accounts.example.json/);
    assert.doesNotMatch(html, /<form\b/);
  });

  test("shows no result panel before a submit", () => {
    const html = renderPage({ config: CONFIG, values: EMPTY });

    assert.doesNotMatch(html, /role="alert"/);
    assert.doesNotMatch(html, /role="status"/);
  });

  test("lists created transactions with formatted amounts", () => {
    const transactions = [{ id: "t1", date: "2026-10-16", payee_name: "SPI", memo: "Ref 1", amount: 7200000 }];
    const html = renderPage({ config: CONFIG, values: EMPTY, result: { ok: true, status: 201, transactions } });

    assert.match(html, /role="status"/);
    assert.match(html, /Created 1 transaction</);
    assert.match(html, /<td>2026-10-16<\/td><td>SPI<\/td><td>Ref 1<\/td><td class="amount inflow">7,200.00<\/td>/);
  });

  test("shows the error and status code in an alert", () => {
    const result = { ok: false as const, status: 400, error: "Invalid budget." };
    const html = renderPage({ config: CONFIG, values: EMPTY, result });

    assert.match(html, /role="alert"/);
    assert.match(html, /HTTP 400/);
    assert.match(html, /Invalid budget\./);
  });

  test("escapes user input and config labels", () => {
    const config = { budgets: [{ label: "<script>b</script>", id: "b", accounts: [{ label: "<script>a</script>", id: "a" }] }] };
    const html = renderPage({ config, values: { ...EMPTY, filePath: '"><script>x</script>' } });

    assert.doesNotMatch(html, /<script>[xab]<\/script>/);
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function close(server: Server): Promise<void> {
  return new Promise<void>((resolve) => server.close(() => resolve()));
}

describe("createAppServer", () => {
  const created = [{ id: "t1", date: "2026-10-16", payee_name: "SPI", memo: "Ref 1", amount: 7200000 }];
  const api = fakeFetch(201, { created: 1, transactions: created });
  let configPath = "";
  let server: Server;
  let baseUrl = "";

  before(async () => {
    configPath = await writeTempFile("accounts.json", JSON.stringify(CONFIG));
    server = createAppServer("http://api.test", configPath, api.fetchImpl);
    baseUrl = await listen(server);
  });

  after(() => close(server));

  test("GET / returns the form with the budgets from the config", async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
    assert.match(html, /<button type="submit">Send transactions<\/button>/);
    assert.match(html, />Personal<\/option>/);
  });

  test("GET / reads the config again on every request", async () => {
    const extended = { budgets: [...CONFIG.budgets, { label: "Travel", id: "t", accounts: [{ label: "Wise", id: "w" }] }] };
    const path = await writeTempFile("accounts.json", JSON.stringify(CONFIG));
    const liveServer = createAppServer("http://api.test", path, api.fetchImpl);
    const url = await listen(liveServer);

    try {
      assert.doesNotMatch(await (await fetch(url)).text(), />Travel</);
      await writeFile(path, JSON.stringify(extended));
      assert.match(await (await fetch(url)).text(), />Travel<\/option>/);
    } finally {
      await close(liveServer);
    }
  });

  test("GET / returns 500 with the config error when the config is missing", async () => {
    const brokenServer = createAppServer("http://api.test", "/nope/accounts.json", api.fetchImpl);
    const url = await listen(brokenServer);

    try {
      const response = await fetch(url);
      const html = await response.text();

      assert.equal(response.status, 500);
      assert.match(html, /Cannot read file &#x27;\/nope\/accounts.json&#x27;/);
      assert.doesNotMatch(html, /<form\b/);
    } finally {
      await close(brokenServer);
    }
  });

  test("POST / sends the file to the API and renders the created transactions", async () => {
    const filePath = await writeTempFile("txns.json", JSON.stringify(TXNS));
    const form = new URLSearchParams({ budget: BUDGET, account: ACCOUNT, filePath });

    const response = await fetch(`${baseUrl}/`, { method: "POST", body: form });
    const html = await response.text();

    assert.equal(response.status, 200);
    assert.match(html, /Created 1 transaction</);
    assert.match(html, new RegExp(`<option value="${ACCOUNT}" selected="">`));
    assert.equal(api.calls.at(-1)?.url, `http://api.test/transactions/${ACCOUNT}?budget=${BUDGET}`);
  });

  test("POST / rejects an account from another budget without calling the API", async () => {
    const callsBefore = api.calls.length;
    const form = new URLSearchParams({ budget: BUDGET, account: OTHER_ACCOUNT, filePath: "/tmp/t.json" });

    const response = await fetch(`${baseUrl}/`, { method: "POST", body: form });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /The selected account does not belong to the selected budget/);
    assert.equal(api.calls.length, callsBefore);
  });

  test("POST / renders the error with the API status code", async () => {
    const failing = fakeFetch(404, { error: "Resource not found" });
    const failingServer = createAppServer("http://api.test", configPath, failing.fetchImpl);
    const url = await listen(failingServer);
    const filePath = await writeTempFile("txns.json", JSON.stringify(TXNS));

    try {
      const form = new URLSearchParams({ budget: BUDGET, account: ACCOUNT, filePath });
      const response = await fetch(url, { method: "POST", body: form });

      assert.equal(response.status, 404);
      assert.match(await response.text(), /Resource not found/);
    } finally {
      await close(failingServer);
    }
  });

  test("POST / with a missing file path returns 400 and the validation error", async () => {
    const form = new URLSearchParams({ budget: BUDGET, account: ACCOUNT });

    const response = await fetch(`${baseUrl}/`, { method: "POST", body: form });

    assert.equal(response.status, 400);
    assert.match(await response.text(), /File path is required/);
  });

  test("POST / rejects an oversized body with 413", async () => {
    const response = await fetch(`${baseUrl}/`, { method: "POST", body: "a".repeat(65 * 1024) });

    assert.equal(response.status, 413);
    assert.match(await response.text(), /Request body is too large/);
  });

  test("unknown paths return 404", async () => {
    const response = await fetch(`${baseUrl}/nope`);

    assert.equal(response.status, 404);
  });
});

describe("loadAccountsConfig", () => {
  test("returns the budgets and accounts from the file", async () => {
    const path = await writeTempFile("accounts.json", JSON.stringify(CONFIG));
    assert.deepEqual(await loadAccountsConfig(path), CONFIG);
  });

  test("throws when the file does not exist", async () => {
    await assert.rejects(loadAccountsConfig("/nope/accounts.json"), {
      message: "Cannot read file '/nope/accounts.json'",
    });
  });

  test("throws when 'budgets' is missing or empty", async () => {
    const path = await writeTempFile("accounts.json", '{"budgets": []}');
    await assert.rejects(loadAccountsConfig(path), { message: "'budgets' must be a non-empty array" });
  });

  test("throws when a budget has no id", async () => {
    const path = await writeTempFile("accounts.json", '{"budgets": [{"label": "A", "accounts": []}]}');
    await assert.rejects(loadAccountsConfig(path), { message: "budgets[0] needs a string 'label' and 'id'" });
  });

  test("throws when a budget has no accounts", async () => {
    const path = await writeTempFile("accounts.json", '{"budgets": [{"label": "A", "id": "b", "accounts": []}]}');
    await assert.rejects(loadAccountsConfig(path), { message: "budgets[0].accounts must be a non-empty array" });
  });

  test("throws when an account has no label", async () => {
    const config = { budgets: [{ label: "A", id: "b", accounts: [{ id: "a" }] }] };
    const path = await writeTempFile("accounts.json", JSON.stringify(config));
    await assert.rejects(loadAccountsConfig(path), {
      message: "budgets[0].accounts[0] needs a string 'label' and 'id'",
    });
  });
});

describe("checkSelection", () => {
  test("accepts an account that belongs to the selected budget", () => {
    assert.equal(checkSelection(CONFIG, BUDGET, ACCOUNT), null);
  });

  test("rejects a budget that is not in the config", () => {
    assert.equal(checkSelection(CONFIG, "unknown", ACCOUNT), "Choose a budget from the list");
  });

  test("rejects an account from a different budget", () => {
    assert.equal(
      checkSelection(CONFIG, BUDGET, OTHER_ACCOUNT),
      "The selected account does not belong to the selected budget",
    );
  });
});

describe("night mode", () => {
  const EMPTY = { account: "", budget: "", filePath: "" };
  const html = renderPage({ config: CONFIG, values: EMPTY });
  const styles = between(html, "<style>", "</style>");

  test("redefines the color tokens for the system dark preference and for an explicit choice", () => {
    assert.match(styles, /@media \(prefers-color-scheme: dark\) \{\s*:root:not\(\[data-theme="light"\]\) \{/);
    assert.match(styles, /:root\[data-theme="dark"\] \{/);
    assert.match(styles, /color-scheme: dark/);
  });

  test("keeps every color in a token", () => {
    const stray = styles.split("\n").filter((line) => /#[0-9a-f]{3,6}\b/i.test(line) && !line.trim().startsWith("--"));
    assert.deepEqual(stray, []);
  });

  test("applies the saved theme in the head, before the body renders", () => {
    const head = between(html, "<head>", "</head>");
    assert.match(head, /<script>[^<]*localStorage\.getItem\("theme"\)/);
  });

  test("renders a night mode toggle button", () => {
    const toggle = openingTag(html, /<button[^>]*class="theme-toggle"/);
    assert.ok(toggle.includes('type="button"') && toggle.includes('aria-pressed="false"'));
    assert.match(html, /class="theme-toggle"[^>]*>Night mode<\/button>/);
  });

  test("shows the toggle on the config error page too", () => {
    const errorPage = renderPage({ configError: "broken", values: EMPTY });
    assert.match(errorPage, /class="theme-toggle"/);
  });
});
