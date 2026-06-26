/**
 * macOS permission models.
 *
 * The per-permission status and a snapshot of both required permissions
 * (screen recording + accessibility) surfaced to the renderer (Req 16, 17).
 */

/** macOS permission status for a single permission (Req 16, 17). */
export type PermissionStatus = 'granted' | 'denied' | 'restricted' | 'not-determined'

/** Snapshot of both required macOS permissions (Req 16, 17). */
export interface PermissionSnapshot {
    screenRecording: PermissionStatus
    accessibility: PermissionStatus
}
