import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";

import { buildTransactionsUrl, expandHome, readTransactionsFile } from "./app.tsx";

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
