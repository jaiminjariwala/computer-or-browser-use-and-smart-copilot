/**
 * Emergency_Stop Hotkey — barrel.
 *
 * Split by concern under `hotkey/` while keeping `./hotkey` as the single import
 * surface:
 *
 *  - `errors.ts`  — the registration failure classification + the typed error
 *    builder the Safety Controller surfaces when it blocks session start
 *    (Req 7.7).
 *  - `manager.ts` — the {@link HotkeyManager} (register / reRegister / cleanup),
 *    the Electron-bound {@link createEmergencyStopManager}, and the pure
 *    session-start / fallback helpers (Req 7.1, 7.3, 7.5, 7.7, 7.8).
 */

export * from './hotkey/errors'
export * from './hotkey/manager'
