import { ipcMain } from 'electron'
import type { PlaybookInput } from '@op-shared/types'
import type { PlaybookStore } from './playbooks'

/**
 * IPC surface for playbooks (`op:playbooks:*`). Kept apart from the store so
 * the store stays electron-free and unit-testable in plain Node.
 *
 * Save/delete return the UPDATED list so the renderer can swap state in one
 * round-trip instead of list-after-write.
 */
export function registerPlaybookIpc(store: PlaybookStore): () => void {
    ipcMain.handle('op:playbooks:list', () => store.list())
    ipcMain.handle('op:playbooks:save', (_event, input: PlaybookInput | undefined) => {
        if (!input || typeof input.goal !== 'string' || typeof input.name !== 'string') {
            return store.list()
        }
        return store.save(input)
    })
    ipcMain.handle('op:playbooks:delete', (_event, payload: { ids?: string[] } | undefined) => {
        const ids = Array.isArray(payload?.ids) ? payload.ids.filter((id) => typeof id === 'string') : []
        return store.delete(ids)
    })
    return () => {
        ipcMain.removeHandler('op:playbooks:list')
        ipcMain.removeHandler('op:playbooks:save')
        ipcMain.removeHandler('op:playbooks:delete')
    }
}
