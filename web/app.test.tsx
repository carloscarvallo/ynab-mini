import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  buildTransactionsUrl,
  expandHome,
  formatAmount,
  readTransactionsFile,
  renderPage,
  submitTransactions,
} from "./app.tsx";

const ACCOUNT = "b5cdc269-13bb-4c3d-b51d-604a453978f4";
const BUDGET = "7fe20706-e3ee-40c9-8e27-20dcc0f79485";
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

describe("renderPage", () => {
  const EMPTY = { account: "", budget: "", filePath: "" };

  test("renders a doctype and a labelled form that posts to the server", () => {
    const html = renderPage({ values: EMPTY });

    const form = openingTag(html, /<form\b/);
    const account = openingTag(html, /<input id="account"/);
    const budget = openingTag(html, /<input id="budget"/);
    const filePath = openingTag(html, /<input id="filePath"/);

    assert.ok(html.startsWith("<!DOCTYPE html>"));
    assert.ok(form.includes('method="post"') && form.includes('action="/"'));
    assert.match(html, /<label for="account">Account<\/label>/);
    assert.ok(account.includes('name="account"') && account.includes('required=""'));
    assert.match(html, /<label for="budget">Budget ID<\/label>/);
    assert.ok(budget.includes('name="budget"') && !budget.includes("required"));
    assert.match(html, /<label for="filePath">File path<\/label>/);
    assert.ok(filePath.includes('name="filePath"') && filePath.includes('required=""'));
    assert.match(html, /<button type="submit">Send transactions<\/button>/);
  });

  test("shows no result panel before a submit", () => {
    const html = renderPage({ values: EMPTY });

    assert.doesNotMatch(html, /role="alert"/);
    assert.doesNotMatch(html, /role="status"/);
  });

  test("keeps the submitted values in the inputs", () => {
    const html = renderPage({ values: { account: ACCOUNT, budget: BUDGET, filePath: "/tmp/t.json" } });

    assert.match(html, new RegExp(`value="${ACCOUNT}"`));
    assert.match(html, new RegExp(`value="${BUDGET}"`));
    assert.match(html, /value="\/tmp\/t.json"/);
  });

  test("lists created transactions with formatted amounts", () => {
    const transactions = [{ id: "t1", date: "2026-10-16", payee_name: "SPI", memo: "Ref 1", amount: 7200000 }];
    const html = renderPage({ values: EMPTY, result: { ok: true, status: 201, transactions } });

    assert.match(html, /role="status"/);
    assert.match(html, /Created 1 transaction</);
    assert.match(html, /<td>2026-10-16<\/td><td>SPI<\/td><td>Ref 1<\/td><td class="amount inflow">7,200.00<\/td>/);
  });

  test("shows the error and status code in an alert", () => {
    const html = renderPage({ values: EMPTY, result: { ok: false, status: 400, error: "Invalid budget." } });

    assert.match(html, /role="alert"/);
    assert.match(html, /HTTP 400/);
    assert.match(html, /Invalid budget\./);
  });

  test("escapes user input", () => {
    const html = renderPage({ values: { ...EMPTY, account: '"><script>x</script>' } });

    assert.doesNotMatch(html, /<script>x<\/script>/);
  });
});
