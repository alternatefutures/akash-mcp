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

  // check to see if we can load the certificate
  if (fs.existsSync(certificatePath)) {
    // Normalize line endings for mTLS compatibility
    const cert = JSON.parse(fs.readFileSync(certificatePath, 'utf8')) as CertificatePem;
    return {
      cert: normalizePem(cert.cert),
      publicKey: normalizePem(cert.publicKey),
      privateKey: normalizePem(cert.privateKey),
    };
  }

  // if not, create a new one
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
      // CRITICAL SECURITY/CORRECTNESS NOTE:
      // If the chain rejects creation because a cert already exists, we MUST NOT
      // persist and return this newly-generated cert. It will NOT match the
      // on-chain cert, and mTLS with providers will fail (or behave inconsistently).
      //
      // In that case, the correct action is either:
      // - keep using the existing local cert (if present), or
      // - revoke existing on-chain cert(s) and regenerate (see regenerate-certificate tool).
      if (error.message?.includes('certificate already exists')) {
        throw new Error(
          'Certificate already exists on-chain, but no local certificate file was found. ' +
            'Refusing to save an unpublished cert. Run the regenerate-certificate tool (revokes + recreates), ' +
            'or restore the existing local cert that matches the on-chain serial.'
        );
      }
      throw new Error(`Could not create certificate: ${error.message}`);
    }
  }

  // Fallback: Just save locally without broadcasting (for when chainSDK is not ready)
  fs.writeFileSync(certificatePath, JSON.stringify(certificate));
  return certificate;
}
