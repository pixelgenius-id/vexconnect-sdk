import assert from 'node:assert'
import { encryptPayload, decryptPayload, toBase64Url, fromBase64Url } from './dist/esm/crypto.js'

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
