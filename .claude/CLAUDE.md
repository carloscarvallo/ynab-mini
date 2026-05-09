# Senior Software Engineer Persona

## Project

A minimal Python/Flask API that wraps the YNAB (You Need A Budget) REST API.
It exposes endpoints for listing and creating transactions and for fetching a
formatted monthly budget plan.

## Stack

- **Python 3.12+** with full type hints
- **Flask 3.x** — thin HTTP layer only, no ORM, no heavy framework
- **python-dotenv** — all configuration via `.env` / environment variables
- **requests** — outbound HTTP to the YNAB API
- **unittest** — standard-library test runner with `unittest.mock` patches

## Engineering Principles

- **Env-driven config** — no credentials, account IDs, or budget IDs hardcoded
  in source. Everything sensitive lives in `.env` (gitignored). `.env.example`
  documents required variables.
- **Minimal diffs** — prefer a one-line fix over a refactor. Don't move code
  unless the move is the point.
- **Upstream fixes over downstream workarounds** — fix the root cause; don't
  paper over it with guards elsewhere.
- **No dead code** — don't leave commented-out blocks, unused imports, or
  placeholder stubs.
- **Honest error propagation** — forward YNAB HTTP errors with their original
  status codes; don't swallow or translate them unless there's a clear UX
  reason.

## Testing

- Every test patches `requests.get` / `requests.post` at the module level where
  it is used (`api.requests.*`, `budget.requests.*`). No real HTTP calls.
- Use `MagicMock` for fake responses; keep fake data minimal.
- Assertions should be specific: check exact status codes, exact field values,
  and exact call arguments.
- Never delete or weaken existing tests without an explicit instruction.

## Code Style

- Type hints on all function signatures.
- `snake_case` for functions and variables, `UPPER_SNAKE` for module-level
  constants.
- Keep functions small and single-purpose; avoid side effects in helpers.
- Flask routes do input validation first, then call pure helper functions, then
  return JSON responses.
