import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function findSelection(
  config: AccountsConfig,
  budgetId: string,
  accountId: string,
): { budget?: BudgetOption; account?: AccountOption } {
  const budget = config.budgets.find(({ id }) => id === budgetId);
  return { budget, account: budget?.accounts.find(({ id }) => id === accountId) };
}

export function checkSelection(config: AccountsConfig, budgetId: string, accountId: string): string | null {
  const { budget, account } = findSelection(config, budgetId, accountId);
  if (!budget) return "Choose a budget from the list";
  if (!account) return "The selected account does not belong to the selected budget";
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

export type PreviewResult = { ok: true; transactions: Transaction[] } | { ok: false; error: string };

export async function previewTransactions(values: FormValues): Promise<PreviewResult> {
  const invalid = validateValues(values);
  if (invalid) return { ok: false, error: invalid };

  try {
    return { ok: true, transactions: await readTransactionsFile(values.filePath.trim()) };
  } catch (error: unknown) {
    return { ok: false, error: errorMessage(error) };
  }
}

export async function submitTransactions(
  values: FormValues,
  apiBase: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SubmitResult> {
  const preview = await previewTransactions(values);
  if (!preview.ok) return preview;
  const { transactions } = preview;

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
  --field: #fffdf8;
  --error-bg: #fbebe7;
  --backdrop: rgb(29 27 22 / 0.45);
  color-scheme: light;
  --font-display: ui-serif, "Iowan Old Style", Georgia, serif;
  --font-mono: ui-monospace, "SF Mono", Menlo, monospace;
  --radius: 4px;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --paper: #17150f;
    --ink: #ece5d6;
    --muted: #a39a88;
    --rule: #3a352b;
    --accent: #7fb8a4;
    --inflow: #7cc48a;
    --outflow: #ef8a7a;
    --field: #201d16;
    --error-bg: #2e1b17;
    --backdrop: rgb(0 0 0 / 0.6);
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --paper: #17150f;
  --ink: #ece5d6;
  --muted: #a39a88;
  --rule: #3a352b;
  --accent: #7fb8a4;
  --inflow: #7cc48a;
  --outflow: #ef8a7a;
  --field: #201d16;
  --error-bg: #2e1b17;
  --backdrop: rgb(0 0 0 / 0.6);
  color-scheme: dark;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
main { max-width: 44rem; margin: 0 auto; padding: 3rem 1rem 4rem; }
header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
h1 { font: 600 2.6rem/1.05 var(--font-display); margin: 0 0 0.25rem; letter-spacing: -0.02em; }
.lede { color: var(--muted); margin: 0 0 2.5rem; }
form { display: grid; gap: 1.25rem; padding: 1.5rem 0; border-top: 2px solid var(--ink); border-bottom: 1px solid var(--rule); }
label { display: block; font-size: 0.75rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: 0.35rem; }
input, select { width: 100%; padding: 0.6rem 0.7rem; font: 0.95rem var(--font-mono); color: var(--ink); background: var(--field); border: 1px solid var(--rule); border-radius: var(--radius); }
input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: var(--accent); }
button { justify-self: start; padding: 0.7rem 1.4rem; font: 600 0.95rem system-ui, sans-serif; color: var(--paper); background: var(--ink); border: 0; border-radius: var(--radius); cursor: pointer; transition: transform 150ms ease-out, background 150ms ease-out; }
button:hover { background: var(--accent); }
button:active { transform: translateY(1px); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.theme-toggle { flex: none; padding: 0.4rem 0.8rem; font-size: 0.8rem; color: var(--ink); background: transparent; border: 1px solid var(--rule); }
.theme-toggle:hover { color: var(--paper); background: var(--ink); }
.theme-toggle[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.theme-toggle[aria-pressed="true"]:hover { color: var(--paper); background: var(--accent); }
button.secondary { color: var(--ink); background: transparent; border: 1px solid var(--rule); }
button.secondary:hover { color: var(--paper); background: var(--ink); }
dialog { width: min(40rem, calc(100% - 2rem)); max-height: calc(100% - 2rem); padding: 1.5rem; color: var(--ink); background: var(--paper); border: 1px solid var(--rule); border-top: 4px solid var(--ink); border-radius: var(--radius); }
dialog::backdrop { background: var(--backdrop); }
dialog h2 { font: 600 1.6rem var(--font-display); margin: 0 0 1rem; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.35rem 1rem; margin: 0 0 1.25rem; }
dt { font-size: 0.7rem; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); padding-top: 0.2rem; }
dd { margin: 0; font-family: var(--font-mono); word-break: break-all; }
details { border-top: 1px solid var(--rule); border-bottom: 1px solid var(--rule); }
summary { padding: 0.75rem 0; font-weight: 600; cursor: pointer; }
summary:hover { color: var(--accent); }
summary:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
details[open] summary { border-bottom: 1px solid var(--rule); margin-bottom: 0.5rem; }
details .table-wrap { padding-bottom: 0.5rem; }
.uuid { color: var(--muted); font-size: 0.85em; white-space: nowrap; }
tfoot th { border-top: 1px solid var(--ink); border-bottom: 0; color: var(--ink); }
dialog form { display: block; padding: 0; border: 0; }
.dialog-actions { display: flex; gap: 0.75rem; margin-top: 1.5rem; }
.result { margin-top: 2rem; }
.result h2 { font: 600 1.4rem var(--font-display); margin: 0 0 0.75rem; }
.error { padding: 1rem 1.1rem; border-left: 4px solid var(--outflow); background: var(--error-bg); white-space: pre-wrap; word-break: break-word; }
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

function selectedBudget(config: AccountsConfig, budgetId: string): BudgetOption {
  return config.budgets.find(({ id }) => id === budgetId) ?? config.budgets[0];
}

function Options({ options }: { options: AccountOption[] }) {
  return (
    <>
      {options.map(({ id, label }) => (
        <option key={id} value={id}>
          {label}
        </option>
      ))}
    </>
  );
}

// Swaps the account options when the budget changes. A constant, never user input.
const ACCOUNT_SWITCHER = `document.getElementById("budget").addEventListener("change", (event) => {
  const template = document.querySelector('template[data-budget="' + CSS.escape(event.target.value) + '"]');
  document.getElementById("account").replaceChildren(template.content.cloneNode(true));
});`;

function TransactionForm({ config, values }: { config: AccountsConfig; values: FormValues }) {
  const budget = selectedBudget(config, values.budget);
  return (
    <form method="post" action="/">
      <div>
        <label htmlFor="budget">Budget</label>
        <select id="budget" name="budget" required defaultValue={budget.id}>
          <Options options={config.budgets} />
        </select>
      </div>
      <div>
        <label htmlFor="account">Account</label>
        <select id="account" name="account" required defaultValue={values.account}>
          <Options options={budget.accounts} />
        </select>
      </div>
      <Field name="filePath" label="File path" hint="/path/to/transactions.json" value={values.filePath} isRequired />
      <button type="submit">Send transactions</button>
      {config.budgets.map(({ id, accounts }) => (
        <template key={id} data-budget={id}>
          <Options options={accounts} />
        </template>
      ))}
      <script dangerouslySetInnerHTML={{ __html: ACCOUNT_SWITCHER }} />
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

function unitsToMilliunits(amount: unknown): number {
  return Math.round(Number(amount ?? 0) * MILLIUNITS_PER_UNIT);
}

// Opens the server-rendered dialog as a modal. A constant, never user input.
const DIALOG_OPENER = `const dialog = document.querySelector("dialog[open]");
dialog.close();
dialog.showModal();`;

type ConfirmDialogProps = {
  budget: BudgetOption;
  account: AccountOption;
  filePath: string;
  transactions: Transaction[];
};

function ConfirmDialog({ budget, account, filePath, transactions }: ConfirmDialogProps) {
  const noun = transactions.length === 1 ? "transaction" : "transactions";
  const total = transactions.reduce((sum, { amount }) => sum + unitsToMilliunits(amount), 0);
  return (
    <>
      <dialog open aria-labelledby="confirm-title">
        <h2 id="confirm-title">Confirm transactions</h2>
        <dl>
          <dt>Budget</dt>
          <dd>{budget.label}</dd>
          <dt>Account</dt>
          <dd>
            {account.label} <span className="uuid">({account.id})</span>
          </dd>
          <dt>File</dt>
          <dd>{filePath}</dd>
        </dl>
        <details>
          <summary>{`Transactions to be sent (${transactions.length}) · Total ${formatAmount(total)}`}</summary>
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
                  <TransactionRow
                    key={index}
                    transaction={{ ...transaction, amount: unitsToMilliunits(transaction.amount) }}
                  />
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th colSpan={3}>Total</th>
                  <th className="amount">{formatAmount(total)}</th>
                </tr>
              </tfoot>
            </table>
          </div>
        </details>
        <form method="post" action="/">
          <input type="hidden" name="budget" value={budget.id} />
          <input type="hidden" name="account" value={account.id} />
          <input type="hidden" name="filePath" value={filePath} />
          <input type="hidden" name="confirm" value="yes" />
          <div className="dialog-actions">
            <button type="submit">
              Send {transactions.length} {noun}
            </button>
            <button type="submit" formMethod="dialog" className="secondary" autoFocus>
              Cancel
            </button>
          </div>
        </form>
      </dialog>
      <script dangerouslySetInnerHTML={{ __html: DIALOG_OPENER }} />
    </>
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

function ConfigErrorPanel({ error }: { error: string }) {
  return (
    <section className="result error" role="alert">
      <strong>Accounts config</strong>
      {error}
      {"\nCopy web/accounts.example.json to web/accounts.json and fill in your budget and account IDs."}
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

// Applies the saved theme before first paint. A constant, never user input.
const THEME_LOADER = `try {
  const theme = localStorage.getItem("theme");
  if (theme === "light" || theme === "dark") document.documentElement.dataset.theme = theme;
} catch {}`;

// Flips between light and dark and remembers the choice. A constant, never user input.
const THEME_TOGGLE = `const toggle = document.querySelector(".theme-toggle");
const isDark = () => (document.documentElement.dataset.theme ?? (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light")) === "dark";
toggle.setAttribute("aria-pressed", String(isDark()));
toggle.addEventListener("click", () => {
  const theme = isDark() ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  toggle.setAttribute("aria-pressed", String(theme === "dark"));
  try { localStorage.setItem("theme", theme); } catch {}
});`;

export type Confirmation = { transactions: Transaction[] };

export type PageProps = { values: FormValues; result?: SubmitResult } & (
  | { config: AccountsConfig; confirmation?: Confirmation }
  | { configError: string }
);

function ConfirmationFor({ config, values, confirmation }: { config: AccountsConfig; values: FormValues; confirmation: Confirmation }) {
  const { budget, account } = findSelection(config, values.budget, values.account);
  if (!budget || !account) return null;
  return (
    <ConfirmDialog budget={budget} account={account} filePath={values.filePath} transactions={confirmation.transactions} />
  );
}

function Page(props: PageProps) {
  const { values, result } = props;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>YNAB Import</title>
        {/* STYLES is a module constant, never user input. */}
        <style dangerouslySetInnerHTML={{ __html: STYLES }} />
        <script dangerouslySetInnerHTML={{ __html: THEME_LOADER }} />
      </head>
      <body>
        <main>
          <header>
            <h1>YNAB Import</h1>
            <button type="button" className="theme-toggle" aria-pressed="false">
              Night mode
            </button>
          </header>
          <p className="lede">Send a JSON file of transactions to an account.</p>
          {"config" in props ? (
            <TransactionForm config={props.config} values={values} />
          ) : (
            <ConfigErrorPanel error={props.configError} />
          )}
          {result && <ResultPanel result={result} />}
          {"config" in props && props.confirmation && (
            <ConfirmationFor config={props.config} values={values} confirmation={props.confirmation} />
          )}
        </main>
        <script dangerouslySetInnerHTML={{ __html: THEME_TOGGLE }} />
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

function formValuesFrom(params: URLSearchParams): FormValues {
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
  config: AccountsConfig,
  apiBase: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const body = await readBody(request);
  if (body === null) {
    const result = { ok: false as const, error: "Request body is too large" };
    sendHtml(response, 413, renderPage({ config, values: EMPTY_VALUES, result }));
    return;
  }

  const params = new URLSearchParams(body);
  const values = formValuesFrom(params);
  const mismatch = checkSelection(config, values.budget, values.account);
  if (mismatch) {
    sendHtml(response, 400, renderPage({ config, values, result: { ok: false, error: mismatch } }));
    return;
  }

  if (params.get("confirm") !== "yes") {
    const preview = await previewTransactions(values);
    const page = preview.ok
      ? renderPage({ config, values, confirmation: { transactions: preview.transactions } })
      : renderPage({ config, values, result: preview });
    sendHtml(response, preview.ok ? 200 : 400, page);
    return;
  }

  const result = await submitTransactions(values, apiBase, fetchImpl);
  const status = result.ok ? 200 : (result.status ?? 400);
  sendHtml(response, status, renderPage({ config, values, result }));
}

export function createAppServer(apiBase: string, configPath: string, fetchImpl: typeof fetch = fetch): Server {
  return createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    if (path !== "/") {
      sendHtml(response, 404, "Not found");
      return;
    }

    // Read on every request so edits to the config apply without a restart.
    let config: AccountsConfig;
    try {
      config = await loadAccountsConfig(configPath);
    } catch (error: unknown) {
      sendHtml(response, 500, renderPage({ configError: errorMessage(error), values: EMPTY_VALUES }));
      return;
    }

    if (request.method === "POST") {
      await handleSubmit(request, response, config, apiBase, fetchImpl);
      return;
    }
    sendHtml(response, 200, renderPage({ config, values: EMPTY_VALUES }));
  });
}

const DEFAULT_API_URL = "http://localhost:5001";
const DEFAULT_WEB_PORT = 5173;
const CONFIG_PATH = fileURLToPath(new URL("./accounts.json", import.meta.url));
// Loopback only: the server reads arbitrary local file paths.
const HOST = "127.0.0.1";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const apiBase = process.env.YNAB_API_URL ?? DEFAULT_API_URL;
  const port = Number(process.env.WEB_PORT ?? DEFAULT_WEB_PORT);
  createAppServer(apiBase, CONFIG_PATH).listen(port, HOST, () => {
    process.stdout.write(`YNAB Import UI on http://${HOST}:${port} (API: ${apiBase})\n`);
  });
}
