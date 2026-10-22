import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type Transaction = Record<string, unknown>;

export function buildTransactionsUrl(apiBase: string, account: string, budget: string): string {
  const url = `${apiBase}/transactions/${encodeURIComponent(account.trim())}`;
  const trimmedBudget = budget.trim();
  return trimmedBudget ? `${url}?budget=${encodeURIComponent(trimmedBudget)}` : url;
}

export function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

export async function readTransactionsFile(path: string): Promise<Transaction[]> {
  let raw: string;
  try {
    raw = await readFile(expandHome(path), "utf8");
  } catch {
    throw new Error(`Cannot read file '${path}'`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`File '${path}' is not valid JSON`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`File '${path}' must contain a JSON array of transactions`);
  }
  return parsed;
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
