## Akash provider burn-in protocol (AlternateFutures)

Goal: run repeated deploy attempts (10–20+) to **measure which providers actually work per service** and what they **cost**, so future deploys can pick **cheap + reliable** providers.

This protocol is designed so a very small/cheap model (or a human operator) can follow it without needing deep repo context.

### What gets recorded (artifacts)

- **Provider registry (service → working/failing)**  
  - **Path**: `akash-mcp/.local/provider-registry.json` (gitignored)  
  - **Meaning**:
    - `services.<service>.working`: providers whose **most recent attempt** for that service succeeded
    - `services.<service>.failing`: providers whose **most recent attempt** for that service failed
    - Each provider row tracks `ok/fail`, `everWorked`, and observed `lastBidAmount` (price).

- **Bids log (all bids seen per attempt, JSONL)**  
  - **Path**: `akash-mcp/.local/provider-bids.jsonl` (gitignored)  
  - Each line is a JSON object containing:
    - `service`, `dseq`, `usableBids[]` (provider + price), `excluded[]`, `selected`, `selectionMode`.
  - Use this to find **cheapest providers that we didn’t necessarily pick**.

### Safety rules (don’t burn money)

- Always use **burn-in mode** so deployments get closed after each run:
  - `AKASH_REDEPLOY_CLOSE_ON_SUCCESS=1`
- Avoid proxy/DNS churn during burn-in:
  - `AKASH_REDEPLOY_SKIP_PROXY=1`
- The script already closes failed attempts during provider failover.

### Prerequisites (one-time)

- Ensure you have:
  - `akash-mcp/.env` with `AKASH_MNEMONIC`
  - `akash-mcp/.env.deploy` with required secrets (see `.env.deploy.example`)
  - Proxy TLS material is NOT required for burn-in mode when `AKASH_REDEPLOY_SKIP_PROXY=1`

### Burn-in run (10–20 iterations)

From `AlternateFutures/akash-mcp`:

```bash
export AKASH_REDEPLOY_SKIP_PROXY=1
export AKASH_REDEPLOY_CLOSE_ON_SUCCESS=1

for i in $(seq 1 20); do
  echo "=== Burn-in iteration $i/20 ==="
  npx tsx scripts/redeploy-all.ts || true
  sleep 15
done
```

Notes:
- If you hit transient chain/RPC timeouts (e.g. HTTP 524), reruns are expected.
- This loop tolerates failures (`|| true`) but still accumulates data.

### What to collect after the burn-in

Upload / share these two files:
- `akash-mcp/.local/provider-registry.json`
- `akash-mcp/.local/provider-bids.jsonl`

Optional (recommended): copy them to timestamped snapshots so they’re easy to diff:

```bash
ts=$(date -u +"%Y%m%dT%H%M%SZ")
mkdir -p akash-mcp/.local/snapshots
cp akash-mcp/.local/provider-registry.json "akash-mcp/.local/snapshots/provider-registry.$ts.json"
cp akash-mcp/.local/provider-bids.jsonl "akash-mcp/.local/snapshots/provider-bids.$ts.jsonl"
```

### How future deploy selection uses this data

`scripts/redeploy-all.ts` will:
- exclude providers that are repeatedly failing for a given service
- prefer the **cheapest bid** among providers that have **everWorked** for that service
- otherwise pick the cheapest bid overall

This means: the more burn-in runs you do, the more accurate your “cheap + working” set becomes.

### Quick “cheapest working providers” report

After the burn-in, run:

```bash
cd akash-mcp
npx tsx scripts/summarize-provider-registry.ts
```

It prints, per service, the providers sorted by `minBidAmount` (when available) plus ok/fail counts.

