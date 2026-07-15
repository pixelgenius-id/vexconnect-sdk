// AES-256-GCM envelope encryption via the platform's native Web Crypto API —
// no crypto library dependency. The relay only ever sees `type`/`topic` for
// routing; `payload` travels as ciphertext it cannot read (blind relay, same
// property WalletConnect's bridge/relay servers have).
//
// The AES key itself is never carried in the pairing URI/QR (unlike the
// SDK's original design) — it's derived per-session via X25519 ECDH, same
// pattern as WalletConnect v2's session key derivation. Only a public key
// travels in the URI or over the relay in the clear; a QR code or logged URI
// alone is useless to an eavesdropper without the wallet's ephemeral private
// key, which never leaves the wallet.

import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'

export interface Envelope {
  iv: string
  ct: string
}

export interface X25519KeyPair {
  secretKey: Uint8Array
  publicKey: Uint8Array
}

/** Fixed HKDF domain-separation string — must match byte-for-byte on every
 * implementation (JS, Kotlin) deriving this session key, or the two sides
 * end up with different AES keys and every message fails to decrypt. */
const HKDF_INFO = new TextEncoder().encode('vexconnect-session-key-v1')

export function generateX25519KeyPair(): X25519KeyPair {
  const secretKey = x25519.utils.randomSecretKey()
  return { secretKey, publicKey: x25519.scalarMultBase(secretKey) }
}

/** ECDH(secretKey, peerPublicKey) -> HKDF-SHA256 -> 32-byte AES-256 key.
 * No salt (HKDF defaults to a zero-filled salt of hash length per RFC 5869
 * when none is given) - only the fixed `info` string separates this key's
 * purpose from any other key ever derived from the same ECDH output. */
export function deriveSessionKey(secretKey: Uint8Array, peerPublicKey: Uint8Array): Uint8Array {
  const shared = x25519.getSharedSecret(secretKey, peerPublicKey)
  return hkdf(sha256, shared, undefined, HKDF_INFO, 32)
}

function toBase64(bytes: Uint8Array): string {
  let bin = ''
  for (const b of bytes) bin += String.fromCharCode(b)
  return btoa(bin)
}

function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

/** URL-safe variant, used only for embedding the key in the pairing URI. */
export function toBase64Url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4
  return fromBase64(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad))
}

function importKey(rawKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', rawKey as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encryptPayload(rawKey: Uint8Array, plaintext: string): Promise<Envelope> {
  const key = await importKey(rawKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(plaintext))
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) }
}

export async function decryptPayload(rawKey: Uint8Array, env: Envelope): Promise<string> {
  const key = await importKey(rawKey)
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(env.iv) as BufferSource },
    key,
    fromBase64(env.ct) as BufferSource,
  )
  return new TextDecoder().decode(pt)
}
