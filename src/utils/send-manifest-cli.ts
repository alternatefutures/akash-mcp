/**
 * Send manifest via the `provider-services` CLI binary.
 *
 * This is the RELIABLE path — the Go binary computes the manifest hash using
 * the same code the provider uses for validation, so there is never a
 * JS-vs-Go canonical JSON mismatch.
 *
 * Falls back to the JS SDK `sendManifest()` if the CLI is not installed.
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';
import os from 'os';
import type { CertificatePem } from '@akashnetwork/chain-sdk';

const execFileAsync = promisify(execFile);

/** Check whether `provider-services` CLI is available on PATH. */
export async function hasProviderServicesCli(): Promise<boolean> {
  try {
    await execFileAsync('provider-services', ['version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

export interface SendManifestCliOptions {
  sdlPath: string;
  dseq: number;
  provider: string;
  /** Akash home directory (must contain keyring + cert). Defaults to ~/.akash */
  home?: string;
  /** Key name in the keyring. Defaults to 'deployer'. */
  keyName?: string;
  /** Keyring backend. Defaults to 'test'. */
  keyringBackend?: string;
  /** RPC node URL. */
  node?: string;
}

/**
 * Send a manifest using the `provider-services` CLI binary.
 *
 * This sets up a temporary Akash home directory with the certificate files,
 * then shells out to `provider-services send-manifest`.
 */
export async function sendManifestCli(opts: SendManifestCliOptions): Promise<string> {
  const {
    sdlPath,
    dseq,
    provider,
    home = path.join(os.homedir(), '.akash'),
    keyName = 'deployer',
    keyringBackend = 'test',
    node = 'https://rpc.akashnet.net:443',
  } = opts;

  const args = [
    'send-manifest',
    sdlPath,
    '--dseq', String(dseq),
    '--provider', provider,
    '--from', keyName,
    '--keyring-backend', keyringBackend,
    '--home', home,
    '--node', node,
  ];

  console.log(`  [sendManifestCli] provider-services ${args.join(' ')}`);

  const { stdout, stderr } = await execFileAsync('provider-services', args, {
    timeout: 60_000,
    env: { ...process.env, HOME: os.homedir() },
  });

  if (stderr && stderr.trim()) {
    console.log(`  [sendManifestCli] stderr: ${stderr.trim()}`);
  }
  if (stdout && stdout.trim()) {
    console.log(`  [sendManifestCli] stdout: ${stdout.trim()}`);
  }

  return stdout;
}

/**
 * Prepare a temporary Akash home directory with certificate files from PEM data.
 * Returns the home directory path. Caller must clean up.
 */
export function prepareAkashHome(
  certPem: CertificatePem,
  address: string,
  existingHome?: string,
): string {
  const home = existingHome || fs.mkdtempSync(path.join(os.tmpdir(), 'akash-'));
  const certDir = home; // akash expects certs in home root

  // Write PEM files in the format the CLI expects
  fs.writeFileSync(path.join(certDir, `${address}.pem`), certPem.cert);
  fs.writeFileSync(path.join(certDir, `${address}.key`), certPem.privateKey);

  return home;
}
