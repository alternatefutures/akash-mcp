import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CertificateManager, type CertificatePem } from '@akashnetwork/chain-sdk';
import type { DirectSecp256k1HdWallet } from '@cosmjs/proto-signing';
import type { ChainNodeSDK, StargateTxClient } from '../types/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Helper to convert PEM string to Uint8Array
function pemToUint8Array(pem: string): Uint8Array {
  return new TextEncoder().encode(pem);
}

// Get the certificates directory path
export function getCertificatesDir(): string {
  // SECURITY:
  // Never store private keys under `src/` (risk of accidental commit + publishing secrets).
  // Use a local, gitignored directory at the package root instead.
  //
  // `__dirname` is either:
  // - `.../akash-mcp/src/utils` during `tsx`
  // - `.../akash-mcp/dist/utils` after build
  // So `../..` consistently resolves to the `akash-mcp/` package root.
  const pkgRoot = path.resolve(__dirname, '../..');
  return path.resolve(pkgRoot, '.local/akash-certs');
}

// Get the certificate path for a specific address
export function getCertificatePath(address: string): string {
  return path.resolve(getCertificatesDir(), `${address}.json`);
}

// Normalize PEM line endings to Unix-style (\n)
function normalizePem(pem: string): string {
  return pem.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

// Load certificate directly from disk (no caching)
export function loadCertificateFromDisk(address: string): CertificatePem | null {
  const certificatePath = getCertificatePath(address);
  if (fs.existsSync(certificatePath)) {
    const cert = JSON.parse(fs.readFileSync(certificatePath, 'utf8')) as CertificatePem;
    // Normalize line endings for all PEM fields
    return {
      cert: normalizePem(cert.cert),
      publicKey: normalizePem(cert.publicKey),
      privateKey: normalizePem(cert.privateKey),
    };
  }
  return null;
}

export async function loadCertificate(
  wallet: DirectSecp256k1HdWallet,
  client: StargateTxClient,
  chainSDK?: ChainNodeSDK
): Promise<CertificatePem> {
  const accounts = await wallet.getAccounts();
  const certificatesDir = getCertificatesDir();

  // Ensure certificates directory exists
  if (!fs.existsSync(certificatesDir)) {
    fs.mkdirSync(certificatesDir, { recursive: true });
  }

  const certificatePath = path.resolve(certificatesDir, `${accounts[0].address}.json`);

  // Priority 1: Load from AKASH_CERT_JSON env var (for containers with ephemeral storage)
  // This avoids on-chain revoke+regenerate on every container restart.
  // Set this env var to the base64-encoded JSON cert file content.
  const certEnv = process.env.AKASH_CERT_JSON;
  if (certEnv) {
    try {
      const decoded = Buffer.from(certEnv, 'base64').toString('utf-8');
      const cert = JSON.parse(decoded) as CertificatePem;
      const normalized = {
        cert: normalizePem(cert.cert),
        publicKey: normalizePem(cert.publicKey),
        privateKey: normalizePem(cert.privateKey),
      };
      // Persist to disk so subsequent loads (e.g. getToolContext) find it
      fs.writeFileSync(certificatePath, JSON.stringify(normalized));
      console.log('[loadCertificate] Loaded certificate from AKASH_CERT_JSON env var');
      return normalized;
    } catch (e: any) {
      console.warn(`[loadCertificate] Failed to parse AKASH_CERT_JSON: ${e.message}`);
    }
  }

  // Priority 2: Load from disk
  if (fs.existsSync(certificatePath)) {
    // Normalize line endings for mTLS compatibility
    const cert = JSON.parse(fs.readFileSync(certificatePath, 'utf8')) as CertificatePem;
    return {
      cert: normalizePem(cert.cert),
      publicKey: normalizePem(cert.publicKey),
      privateKey: normalizePem(cert.privateKey),
    };
  }

  // No local certificate found — generate a new one
  const certManager = new CertificateManager();
  const certificate = await certManager.generatePEM(accounts[0].address);

  // Broadcast certificate using chain SDK if available
  if (chainSDK) {
    try {
      await chainSDK.akash.cert.v1.createCertificate({
        owner: accounts[0].address,
        cert: pemToUint8Array(certificate.cert),
        pubkey: pemToUint8Array(certificate.publicKey),
      });
      // save the certificate
      fs.writeFileSync(certificatePath, JSON.stringify(certificate));
      return certificate;
    } catch (error: any) {
      // If a cert already exists on-chain but we don't have the local file (e.g. container
      // restart with ephemeral storage), auto-recover by revoking and regenerating.
      // This is essential for Akash deployments where the container storage is not persistent.
      if (error.message?.includes('certificate already exists')) {
        console.warn(
          '[loadCertificate] Certificate exists on-chain but no local file. Auto-regenerating...'
        );
        return await autoRegenerateCertificate(
          accounts[0].address,
          chainSDK,
          certificatePath
        );
      }
      throw new Error(`Could not create certificate: ${error.message}`);
    }
  }

  // Fallback: Just save locally without broadcasting (for when chainSDK is not ready)
  fs.writeFileSync(certificatePath, JSON.stringify(certificate));
  return certificate;
}

/**
 * Auto-regenerate certificate when local file is lost but cert exists on-chain.
 * Revokes all existing certs and creates a fresh one.
 * This enables MCP to survive container restarts with ephemeral storage.
 */
async function autoRegenerateCertificate(
  address: string,
  chainSDK: ChainNodeSDK,
  savePath: string
): Promise<CertificatePem> {
  // Step 1: Revoke all existing certificates
  try {
    const certsResponse = await chainSDK.akash.cert.v1.getCertificates({
      filter: { owner: address, serial: '', state: 'valid' },
      pagination: undefined,
    });

    const certificates = certsResponse.certificates || [];
    for (const cert of certificates) {
      const serial = cert.serial;
      if (!serial) continue;
      try {
        await chainSDK.akash.cert.v1.revokeCertificate({
          id: { owner: address, serial },
        });
        console.log(`[loadCertificate] Revoked certificate serial: ${serial}`);
      } catch (revokeErr: any) {
        console.warn(`[loadCertificate] Failed to revoke cert ${serial}: ${revokeErr.message}`);
      }
    }
  } catch (queryErr: any) {
    console.warn(`[loadCertificate] Failed to query certs for revocation: ${queryErr.message}`);
  }

  // Step 2: Generate and publish a fresh certificate
  const certManager = new CertificateManager();
  const newCert = await certManager.generatePEM(address);

  try {
    await chainSDK.akash.cert.v1.createCertificate({
      owner: address,
      cert: pemToUint8Array(newCert.cert),
      pubkey: pemToUint8Array(newCert.publicKey),
    });
  } catch (createErr: any) {
    throw new Error(
      `Auto-regenerate failed: could not create new certificate after revoking old ones: ${createErr.message}`
    );
  }

  // Step 3: Save to disk
  fs.writeFileSync(savePath, JSON.stringify(newCert));
  console.log('[loadCertificate] Auto-regenerated certificate successfully.');
  return newCert;
}
