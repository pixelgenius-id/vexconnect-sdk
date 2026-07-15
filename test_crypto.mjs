import assert from 'node:assert'
import { encryptPayload, decryptPayload, toBase64Url, fromBase64Url, generateX25519KeyPair, deriveSessionKey } from './dist/esm/crypto.js'

const key = crypto.getRandomValues(new Uint8Array(32))
const plaintext = JSON.stringify({ account: 'kunka', publicKey: 'VEX_PUB...' })

const env = await encryptPayload(key, plaintext)
assert.notStrictEqual(env.ct, plaintext, 'ciphertext must not equal plaintext')
const decrypted = await decryptPayload(key, env)
assert.strictEqual(decrypted, plaintext, 'round-trip must match original')

// wrong key must fail to decrypt (authenticity check)
const wrongKey = crypto.getRandomValues(new Uint8Array(32))
await assert.rejects(() => decryptPayload(wrongKey, env), 'wrong key must reject, not silently decrypt garbage')

// key survives base64url round-trip (as embedded in the pairing URI)
const encoded = toBase64Url(key)
assert.deepStrictEqual(fromBase64Url(encoded), key, 'key must survive base64url round-trip')

console.log('OK: encrypt/decrypt round-trip, wrong-key rejection, and key base64url round-trip all pass')

// ECDH handshake: both sides must derive the identical AES key from their
// own secret + the other side's public key, and a third party's keypair
// must NOT be able to derive the same key (confirms the derivation actually
// binds to both public keys, not just one).
const dapp   = generateX25519KeyPair()
const wallet = generateX25519KeyPair()
const eve    = generateX25519KeyPair()

const dappKey   = deriveSessionKey(dapp.secretKey, wallet.publicKey)
const walletKey = deriveSessionKey(wallet.secretKey, dapp.publicKey)
assert.deepStrictEqual(dappKey, walletKey, 'both sides must derive the same session key from ECDH')

const eveKey = deriveSessionKey(eve.secretKey, dapp.publicKey)
assert.notDeepStrictEqual(eveKey, dappKey, 'a third party keypair must not derive the real session key')

// the derived key must actually work as an AES-256 key end to end
const msg = JSON.stringify({ account: 'kunka', publicKey: 'VEX_PUB...' })
const sealed = await encryptPayload(dappKey, msg)
assert.strictEqual(await decryptPayload(walletKey, sealed), msg, 'ECDH-derived key must decrypt what the other side encrypted')

console.log('OK: X25519 ECDH derives matching session keys on both sides, rejects a third party, and works as an AES key')
