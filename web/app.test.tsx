import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildTransactionsUrl, expandHome, readTransactionsFile, submitTransactions } from "./app.tsx";

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
