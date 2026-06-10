/**
 * Tray (menu-bar) Manager.
 *
 * The menu-bar fallback for when the `Global_Hotkey` cannot be registered for a
 * reason other than a conflict (Req 1.5). When the hotkey is unavailable the
 * user still needs a way to summon Glass, so this manager adds an Electron
 * `Tray` entry whose click — and whose "Open Glass" menu item — shows and
 * focuses the Sidebar_Panel.
 *
 * Creating a `Tray` is idempotent here: calling {@link TrayManager.show} more
 * than once reuses the existing icon rather than stacking duplicates, so a
 * repeated failed registration won't litter the menu bar.
 *
 * `electron` is mocked in tests, so the manager is exercised without a real
 * menu-bar icon. See design.md "Hotkey + Tray Manager" and the
 * "Error, Permission, and Edge Handling matrix" (row: "Hotkey fails
 * (non-conflict)").
 *
 * Requirements: 1.5
 */

import { Tray, Menu, nativeImage } from 'electron'

/**
 * The minimal surface the Tray needs to bring Glass to the foreground: show and
 * focus the Sidebar. The WindowManager (and the main entry's `showSidebar`)
 * satisfy this directly; keeping it as a tiny interface lets the manager be
 * unit-tested without a real window.
 */
export interface SidebarOpener {
    /** Show and focus the Sidebar_Panel (Req 1.5). */
    showSidebar(): void
}

/** Tooltip shown when hovering the menu-bar icon. */
export const TRAY_TOOLTIP = 'Glass — open the sidebar'

/**
 * Owns the lifecycle of the menu-bar (Tray) fallback icon. A single instance
 * manages at most one `Tray` at a time.
 */
export class TrayManager {
    private readonly opener: SidebarOpener
    private tray: Tray | null = null

    constructor(opener: SidebarOpener) {
        this.opener = opener
    }

    /** Whether a menu-bar icon is currently active. */
    isActive(): boolean {
        return this.tray !== null
    }

    /**
     * Create and show the menu-bar icon (Req 1.5). Idempotent: if an icon is
     * already active it is returned unchanged. Both a direct click on the icon
     * and the "Open Glass" menu item show+focus the Sidebar.
     */
    show(): Tray {
        if (this.tray) {
            return this.tray
        }

        // An empty image yields a (blank) menu-bar entry without bundling an
        // asset; the click/menu behavior is what matters for the fallback.
        const icon = nativeImage.createEmpty()
        const tray = new Tray(icon)
        tray.setToolTip(TRAY_TOOLTIP)

        const menu = Menu.buildFromTemplate([
            {
                label: 'Open Glass',
                click: () => this.opener.showSidebar()
            },
            { type: 'separator' },
            { label: 'Quit Glass', role: 'quit' }
        ])
        tray.setContextMenu(menu)

        // A left-click on the icon also opens the sidebar (Req 1.5).
        tray.on('click', () => this.opener.showSidebar())

        this.tray = tray
        return tray
    }

    /** Remove the menu-bar icon and clear state. Safe to call when inactive. */
    destroy(): void {
        this.tray?.destroy()
        this.tray = null
    }
}
