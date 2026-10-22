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
