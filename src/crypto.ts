// AES-256-GCM envelope encryption via the platform's native Web Crypto API —
// no crypto library dependency. The relay only ever sees `type`/`topic` for
// routing; `payload` travels as ciphertext it cannot read (blind relay, same
// property WalletConnect's bridge/relay servers have).

export interface Envelope {
  iv: string
  ct: string
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
