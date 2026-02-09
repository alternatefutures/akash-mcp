import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export type ProviderOutcome = 'working' | 'failing';

export type ProviderRegistryProvider = {
  ok: number;
  fail: number;
  everWorked: boolean;
  everFailed: boolean;
  lastOkAt?: string;
  lastFailAt?: string;
  lastFailReason?: string;
  lastDseq?: number;
  // Bid price observed on the most recent attempt for this provider+service.
  // This is the on-chain bid "price" (typically uakt per block) for the group.
  lastBidAmount?: string;
  lastBidDenom?: string;
  lastBidAt?: string;
  // Simple range tracking across attempts (stringified decimals).
  minBidAmount?: string;
  maxBidAmount?: string;
};

export type ProviderRegistryService = {
  // Providers are placed into exactly one bucket based on last outcome, but
  // we keep `everWorked`/`everFailed` so history isn’t lost when a provider flips.
  working: Record<string, ProviderRegistryProvider>;
  failing: Record<string, ProviderRegistryProvider>;
};

export type ProviderRegistry = {
  version: 1;
  updatedAt: string;
  services: Record<string, ProviderRegistryService>;
};

export function defaultProviderRegistryPath(): string {
  // src/utils -> package root
  const packageRoot = path.resolve(__dirname, '../..');
  return process.env.AKASH_PROVIDER_REGISTRY_PATH || path.join(packageRoot, '.local/provider-registry.json');
}

export function loadProviderRegistry(registryPath = defaultProviderRegistryPath()): ProviderRegistry {
  try {
    if (fs.existsSync(registryPath)) {
      const raw = fs.readFileSync(registryPath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.services) return parsed as ProviderRegistry;
    }
  } catch {
    // ignore malformed registry; we'll overwrite on next save
  }
  return { version: 1, updatedAt: new Date().toISOString(), services: {} };
}

export function saveProviderRegistry(registry: ProviderRegistry, registryPath = defaultProviderRegistryPath()) {
  registry.updatedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(registryPath), { recursive: true });
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

function upsertProvider(
  svc: ProviderRegistryService,
  bucket: ProviderOutcome,
  provider: string
): ProviderRegistryProvider {
  const fromOther = bucket === 'working' ? svc.failing[provider] : svc.working[provider];
  const existing = (bucket === 'working' ? svc.working[provider] : svc.failing[provider]) || fromOther;
  const next: ProviderRegistryProvider = existing || { ok: 0, fail: 0, everWorked: false, everFailed: false };

  // Ensure provider exists only in one bucket (move on update)
  if (bucket === 'working') {
    delete svc.failing[provider];
    svc.working[provider] = next;
  } else {
    delete svc.working[provider];
    svc.failing[provider] = next;
  }
  return next;
}

export function recordProviderResult(args: {
  service: string;
  provider: string;
  outcome: ProviderOutcome;
  reason?: string;
  dseq?: number;
  bidAmount?: string;
  bidDenom?: string;
  registryPath?: string;
}) {
  const registryPath = args.registryPath || defaultProviderRegistryPath();
  const registry = loadProviderRegistry(registryPath);
  const svc = (registry.services[args.service] ||= { working: {}, failing: {} });

  const row = upsertProvider(svc, args.outcome, args.provider);
  const now = new Date().toISOString();

  if (args.outcome === 'working') {
    row.ok = (row.ok || 0) + 1;
    row.everWorked = true;
    row.lastOkAt = now;
  } else {
    row.fail = (row.fail || 0) + 1;
    row.everFailed = true;
    row.lastFailAt = now;
    if (args.reason) row.lastFailReason = String(args.reason).slice(0, 800);
  }
  if (args.dseq) row.lastDseq = args.dseq;
  if (args.bidAmount) {
    row.lastBidAmount = String(args.bidAmount);
    row.lastBidDenom = String(args.bidDenom || row.lastBidDenom || 'uakt');
    row.lastBidAt = now;

    const cur = Number(args.bidAmount);
    if (Number.isFinite(cur)) {
      const min = row.minBidAmount ? Number(row.minBidAmount) : Number.NaN;
      const max = row.maxBidAmount ? Number(row.maxBidAmount) : Number.NaN;
      if (!Number.isFinite(min) || cur < min) row.minBidAmount = String(args.bidAmount);
      if (!Number.isFinite(max) || cur > max) row.maxBidAmount = String(args.bidAmount);
    }
  }

  try {
    saveProviderRegistry(registry, registryPath);
  } catch {
    // best-effort: tracking must never break deployments
  }
}

export function getFailingProvidersForService(args: {
  service: string;
  minFails?: number;
  registryPath?: string;
}): Set<string> {
  const registryPath = args.registryPath || defaultProviderRegistryPath();
  const minFails = args.minFails ?? 2;
  const registry = loadProviderRegistry(registryPath);
  const svc = registry.services[args.service];
  if (!svc) return new Set();

  const out = new Set<string>();
  for (const [provider, row] of Object.entries(svc.failing || {})) {
    if ((row.fail || 0) >= minFails) out.add(provider);
  }
  return out;
}

export function getKnownWorkingProvidersForService(args: {
  service: string;
  registryPath?: string;
}): Set<string> {
  const registryPath = args.registryPath || defaultProviderRegistryPath();
  const registry = loadProviderRegistry(registryPath);
  const svc = registry.services[args.service];
  if (!svc) return new Set();

  const out = new Set<string>();
  for (const [provider, row] of Object.entries(svc.working || {})) {
    if (row.everWorked) out.add(provider);
  }
  for (const [provider, row] of Object.entries(svc.failing || {})) {
    if (row.everWorked) out.add(provider);
  }
  return out;
}

