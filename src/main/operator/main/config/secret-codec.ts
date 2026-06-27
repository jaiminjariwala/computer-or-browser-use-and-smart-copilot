import { safeStorage } from 'electron'

/**
 * Secret codec (OS keychain-backed encryption), abstracted for testability.
 *
 * API keys are the one piece of state we refuse to keep in plaintext: they
 * never touch `config.json` and only ever land on disk after passing through
 * this codec. The interface exists so tests can inject a reversible fake and
 * assert the encrypted-at-rest guarantee without a real OS keychain.
 */

/** Abstraction over the OS keychain-backed encryption, for testability. */
export interface SecretCodec {
    isEncryptionAvailable(): boolean
    encryptString(plain: string): Buffer
    decryptString(data: Buffer): string
}

/** Default codec backed by Electron `safeStorage`. */
export const safeStorageCodec: SecretCodec = {
    isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
    encryptString: (plain) => safeStorage.encryptString(plain),
    decryptString: (data) => safeStorage.decryptString(data)
}

/**
 * Thrown when a key cannot be encrypted because the OS keychain is unavailable
 * (e.g. headless Linux). Rather than silently writing plaintext, we fail loud;
 * the IPC layer maps this to an error the user can act on.
 */
export class EncryptionUnavailableError extends Error {
    constructor() {
        super('Secure storage is unavailable on this system; cannot store the API key.')
        this.name = 'EncryptionUnavailableError'
    }
}
