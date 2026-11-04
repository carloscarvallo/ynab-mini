import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { renderToStaticMarkup } from "react-dom/server";

export type Transaction = Record<string, unknown>;

export function buildTransactionsUrl(apiBase: string, account: string, budget: string): string {
  const url = `${apiBase}/transactions/${encodeURIComponent(account.trim())}`;
  const trimmedBudget = budget.trim();
  return trimmedBudget ? `${url}?budget=${encodeURIComponent(trimmedBudget)}` : url;
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

async function readJsonFile(path: string): Promise<unknown> {
  let raw: string;
  try {
    raw = await readFile(expandHome(path), "utf8");
  } catch {
    throw new Error(`Cannot read file '${path}'`);
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`File '${path}' is not valid JSON`);
  }
}

export async function readTransactionsFile(path: string): Promise<Transaction[]> {
  const parsed = await readJsonFile(path);
  if (!Array.isArray(parsed)) {
    throw new Error(`File '${path}' must contain a JSON array of transactions`);
  }
  return parsed;
}

export type AccountOption = { label: string; id: string };
export type BudgetOption = AccountOption & { accounts: AccountOption[] };
export type AccountsConfig = { budgets: BudgetOption[] };

function isOption(value: unknown): value is AccountOption {
  if (typeof value !== "object" || value === null) return false;
  const { label, id } = value as Record<string, unknown>;
  return typeof label === "string" && typeof id === "string";
}

function parseAccountsConfig(parsed: unknown): AccountsConfig {
  const budgets = (parsed as { budgets?: unknown } | null)?.budgets;
  if (!Array.isArray(budgets) || budgets.length === 0) {
    throw new Error("'budgets' must be a non-empty array");
  }
  return {
    budgets: budgets.map((budget: unknown, b: number) => {
      if (!isOption(budget)) throw new Error(`budgets[${b}] needs a string 'label' and 'id'`);
      const { accounts } = budget as { accounts?: unknown };
      if (!Array.isArray(accounts) || accounts.length === 0) {
        throw new Error(`budgets[${b}].accounts must be a non-empty array`);
      }
      return {
        label: budget.label,
        id: budget.id,
        accounts: accounts.map((account: unknown, a: number) => {
          if (!isOption(account)) throw new Error(`budgets[${b}].accounts[${a}] needs a string 'label' and 'id'`);
          return { label: account.label, id: account.id };
        }),
      };
    }),
  };
}

export async function loadAccountsConfig(path: string): Promise<AccountsConfig> {
  return parseAccountsConfig(await readJsonFile(path));
}

export function checkSelection(config: AccountsConfig, budgetId: string, accountId: string): string | null {
  const budget = config.budgets.find(({ id }) => id === budgetId);
  if (!budget) return "Choose a budget from the list";
  if (!budget.accounts.some(({ id }) => id === accountId)) {
    return "The selected account does not belong to the selected budget";
  }
  return null;
}

export type FormValues = { account: string; budget: string; filePath: string };

export type SubmitResult =
  | { ok: true; status: number; transactions: Transaction[] }
  | { ok: false; status?: number; error: string };

function validateValues({ account, filePath }: FormValues): string | null {
  if (!account.trim()) return "Account is required";
  if (!filePath.trim()) return "File path is required";
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unexpected error";
}

export async function submitTransactions(
  values: FormValues,
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  const invalid = validateValues(values);
  if (invalid) return { ok: false, error: invalid };

  let transactions: Transaction[];
  try {
    transactions = await readTransactionsFile(values.filePath.trim());
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) };
  }

  let response: Response;
  try {
    response = await fetchImpl(buildTransactionsUrl(apiBase, values.account, values.budget), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(transactions),
    });
  } catch {
    return { ok: false, error: `Cannot reach the API at ${apiBase}. Is it running?` };
  }

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { ok: false, status: response.status, error: body.error ?? response.statusText };
  }
  return { ok: true, status: response.status, transactions: body.transactions ?? [] };
}

const MILLIUNITS_PER_UNIT = 1000;

export function formatAmount(milliunits: number): string {
  return (milliunits / MILLIUNITS_PER_UNIT).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

const STYLES = `
:root {
  --paper: #f6f1e7;
  --ink: #1d1b16;
  --muted: #6b6457;
  --rule: #d8cfbd;
  --accent: #2f5d50;
  --inflow: #2f6b3a;
  --outflow: #a3392b;
  --font-display: ui-serif, "Iowan Old Style", Georgia, serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --radius: 4px;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
h1 { font: 600 2.6rem/1.05 var(--font-display); margin: 0 0 0.25rem; letter-spacing: -0.02em; }
.lede { color: var(--muted); margin: 0 0 2.5rem; }
form { display: grid; gap: 1.25rem; padding: 1.5rem 0; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); }
label { display: block; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.35rem; }
input { width: 100%; padding: 0.6rem 0.7rem; font: 0.95rem var(--font-mono); color: var(--ink); background: #fffdf8; border: 1px solid var(--rule); border-radius: var(--radius); }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
button { justify-self: start; padding: 0.7rem 1.4rem; font: 600 0.95rem system-ui, sans-serif; color: var(--paper); background: var(--ink); border: 0; border-radius: var(--radius); cursor: pointer; transition: transform 150ms ease-out, background 150ms ease-out; }
button:hover { background: var(--accent); }
button:active { transform: translateY(1px); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.result { margin-top: 2rem; }
.result h2 { font: 600 1.4rem var(--font-display); margin: 0 0 0.75rem; }
.error { padding: 1rem 1.1rem; border-left: 4px solid var(--outflow); background: #fbebe7; white-space: pre-wrap; word-break: break-word; }
.error strong { display: block; font-family: var(--font-mono); color: var(--outflow); }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 0.9rem; }
th { text-align: left; font-size: 0.7rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); border-bottom: 1px solid var(--ink); padding: 0.4rem 0.5rem; }
td { padding: 0.5rem; border-bottom: 1px solid var(--rule); }
.amount { text-align: right; font-family: var(--font-mono); white-space: nowrap; }
.inflow { color: var(--inflow); }
.outflow { color: var(--outflow); }
`;

type FieldProps = { name: keyof FormValues; label: string; hint?: string; value: string; isRequired?: boolean };

function Field({ name, label, hint, value, isRequired = false }: FieldProps) {
  return (
    <div>
      <label htmlFor={name}>{label}</label>
      <input id={name} name={name} required={isRequired} defaultValue={value} placeholder={hint} spellCheck={false} />
    </div>
  );
}

function TransactionForm({ values }: { values: FormValues }) {
  return (
    <form method="post" action="/">
      <Field name="account" label="Account" hint="Account UUID, checking or cc" value={values.account} isRequired />
      <Field name="budget" label="Budget ID" hint="Budget UUID (blank uses the default)" value={values.budget} />
      <Field name="filePath" label="File path" hint="/path/to/transactions.json" value={values.filePath} isRequired />
      <button type="submit">Send transactions</button>
    </form>
  );
}

function TransactionRow({ transaction }: { transaction: Transaction }) {
  const amount = Number(transaction.amount ?? 0);
  const flow = amount < 0 ? "outflow" : "inflow";
  return (
    <tr>
      <td>{String(transaction.date ?? "")}</td>
      <td>{String(transaction.payee_name ?? "")}</td>
      <td>{String(transaction.memo ?? "")}</td>
      <td className={`amount ${flow}`}>{formatAmount(amount)}</td>
    </tr>
  );
}

function SuccessPanel({ transactions }: { transactions: Transaction[] }) {
  const noun = transactions.length === 1 ? "transaction" : "transactions";
  return (
    <section className="result" role="status">
      <h2>
        Created {transactions.length} {noun}
      </h2>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Date</th>
              <th>Payee</th>
              <th>Memo</th>
              <th className="amount">Amount</th>
            </tr>
          </thead>
          <tbody>
            {transactions.map((transaction, index) => (
              <TransactionRow key={String(transaction.id ?? index)} transaction={transaction} />
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function ErrorPanel({ status, error }: { status?: number; error: string }) {
  return (
    <section className="result error" role="alert">
      {status !== undefined && <strong>HTTP {status}</strong>}
      {error}
    </section>
  );
}

function ResultPanel({ result }: { result: SubmitResult }) {
  return result.ok ? (
    <SuccessPanel transactions={result.transactions} />
  ) : (
    <ErrorPanel status={result.status} error={result.error} />
  );
}

export type PageProps = { values: FormValues; result?: SubmitResult };

function Page({ values, result }: PageProps) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>YNAB Import</title>
        {/* STYLES is a module constant, never user input. */}
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
      </head>
      <body>
        <main>
          <h1>YNAB Import</h1>
          <p className="lede">Send a JSON file of transactions to an account.</p>
          <TransactionForm values={values} />
          {result && <ResultPanel result={result} />}
        </main>
      </body>
    </html>
  );
}

export function renderPage(props: PageProps): string {
  return `<!DOCTYPE html>${renderToStaticMarkup(<Page {...props} />)}`;
}

const MAX_BODY_BYTES = 64 * 1024;
const EMPTY_VALUES: FormValues = { account: "", budget: "", filePath: "" };

async function readBody(request: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function formValuesFrom(body: string): FormValues {
  const params = new URLSearchParams(body);
  return {
    account: params.get("account") ?? "",
    budget: params.get("budget") ?? "",
    filePath: params.get("filePath") ?? "",
  };
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
}

async function handleSubmit(
  request: IncomingMessage,
  response: ServerResponse,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = await readBody(request);
  if (body === null) {
    sendHtml(response, 413, renderPage({ values: EMPTY_VALUES, result: { ok: false, error: "Request body is too large" } }));
    return;
  }

  const values = formValuesFrom(body);
  const result = await submitTransactions(values, apiBase, fetchImpl);
  const status = result.ok ? 200 : (result.status ?? 400);
  sendHtml(response, status, renderPage({ values, result }));
}

export function createAppServer(apiBase: string, fetchImpl: typeof fetch = fetch): Server {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/") {
      sendHtml(response, 404, "Not found");
      return;
    }
    if (request.method === "POST") {
      await handleSubmit(request, response, apiBase, fetchImpl);
      return;
    }
    sendHtml(response, 200, renderPage({ values: EMPTY_VALUES }));
  });
}

const DEFAULT_API_URL = "http://localhost:5001";
const DEFAULT_WEB_PORT = 5173;
// Loopback only: the server reads arbitrary local file paths.
const HOST = "127.0.0.1";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiBase = process.env.YNAB_API_URL ?? DEFAULT_API_URL;
  const port = Number(process.env.WEB_PORT ?? DEFAULT_WEB_PORT);
  createAppServer(apiBase).listen(port, HOST, () => {
    process.stdout.write(`YNAB Import UI on http://${HOST}:${port} (API: ${apiBase})\n`);
  });
}
