import type { Browser, BrowserContext, Page } from 'playwright'
import type { Action, ActionResult, Observation, OperatorError, Point } from '@op-shared/types'
import type { CaptureOptions, PerceptionResult } from '../perception'
import { preflightAction } from '../validate'
import type { Environment, EnvironmentHealth, EnvironmentViewport } from './types'

/**
 * PlaywrightBrowserEnvironment — a real, scriptable web browser as an operator
 * Execution_Environment (Req 22), the DOM-aware alternative to pixel-only
 * control.
 *
 * It implements the same {@link Environment} seam as the local desktop and the
 * container desktop, so the agent loop, Safety Controller, autonomy gating,
 * Step_Budget, and Emergency_Stop are all unchanged. What makes browser use far
 * more reliable than raw vision is HYBRID perception + DOM-snapped execution:
 *
 *  - `capture()` returns a bounded page-text digest, minimized tab metadata, and
 *    interactive elements (links, buttons, inputs) as `a11yElements`, each with
 *    its on-page rectangle. Browser reasoning stays text-first while the user
 *    watches the visible Chromium window.
 *  - `execute()` realizes actions through Playwright. Coordinate clicks are
 *    SNAPPED to the nearest interactive element center, so a click that lands a
 *    few pixels off (the usual cause of browser misclicks) still hits the right
 *    control. Typing/keys/scroll go through Playwright's input APIs.
 *
 * Playwright is imported lazily (and is marked `external` in the main build), so
 * the app never loads it unless the user actually selects this environment.
 * No browser install step is required: launch falls back from the
 * Playwright-managed Chromium (dev machines) to the user's own Chrome / Edge /
 * Brave, so a fresh download of the app can drive the web immediately.
 */

/** One interactive element on the page, in CSS-pixel page coordinates. */
interface DomElement {
    role: string
    title: string
    /** Center point (page pixels) — the click target. */
    cx: number
    cy: number
    bounds: { x: number; y: number; width: number; height: number }
}

export interface BrowserEnvironmentDeps {
    /** Viewport / coordinate space. Defaults to 1280×800. */
    viewport?: { width: number; height: number }
    /** Launch headless (no visible window). Defaults to false so the user watches. */
    headless?: boolean
    /** First page to open on start. Defaults to a blank page. */
    startUrl?: string
    /**
     * Max distance (page px) a coordinate click may be snapped to an element
     * center. Beyond this the raw coordinate is used. Defaults to 60.
     */
    snapRadius?: number
    /** Id factory for Observations (test seam). */
    generateId?: () => string
    /** Clock for `capturedAt` (test seam). */
    now?: () => string
}

let browserObsCounter = 0
function defaultGenerateId(): string {
    browserObsCounter += 1
    return `br_${Date.now().toString(36)}_${browserObsCounter.toString(36)}`
}

/**
 * Script evaluated in the page to collect interactive elements with their
 * bounding rectangles. Kept as a string-free function so Playwright serializes
 * it; returns only elements currently visible in the viewport.
 */
function collectInteractiveElements(): Array<{
    role: string
    title: string
    x: number
    y: number
    width: number
    height: number
}> {
    const SELECTOR =
        'a,button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="menuitem"],[onclick],[contenteditable="true"]'
    const out: Array<{
        role: string
        title: string
        x: number
        y: number
        width: number
        height: number
    }> = []
    const nodes = Array.from(document.querySelectorAll(SELECTOR)).slice(0, 250)
    for (const el of nodes) {
        const r = el.getBoundingClientRect()
        if (r.width <= 1 || r.height <= 1) continue
        if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) {
            continue
        }
        const element = el as HTMLElement
        const label =
            element.getAttribute('aria-label') ||
            element.getAttribute('placeholder') ||
            element.getAttribute('name') ||
            (element.innerText || element.textContent || '').trim().slice(0, 80) ||
            element.getAttribute('title') ||
            element.tagName.toLowerCase()
        out.push({
            role: el.getAttribute('role') || el.tagName.toLowerCase(),
            title: label,
            x: r.left,
            y: r.top,
            width: r.width,
            height: r.height
        })
    }
    return out
}

/**
 * Evaluated in the page to produce a readable text digest (title, URL, and the
 * main visible copy) so the agent can read page CONTENT from text rather than
 * an image. Capped so the prompt stays bounded.
 */
function readPageDigest(): { title: string; url: string; text: string } {
    const title = document.title || ''
    const url = location.href
    const main =
        (document.querySelector('main, article, [role="main"]') as HTMLElement | null) ||
        document.body
    const src = (main?.innerText || '').replace(/[ \t]+\n/g, '\n')
    const text = src.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
    return { title, url, text }
}

/**
 * Reduce provider-facing URL metadata to an origin (or a non-network scheme
 * marker). Paths are omitted because reset, invite, account, and signed-object
 * URLs commonly carry secrets in path segments as well as queries/fragments.
 */
function minimizePageUrl(value: string): string {
    try {
        const url = new URL(value)
        if (url.protocol === 'http:' || url.protocol === 'https:') {
            return url.origin.slice(0, 180)
        }
        if (url.protocol === 'about:') return 'about:blank'
        return `${url.protocol}//`.slice(0, 180)
    } catch {
        return '(unavailable)'
    }
}

export class PlaywrightBrowserEnvironment implements Environment {
    // Reuse the existing EnvironmentId space; 'browser' is added to the union.
    readonly id = 'browser' as const

    private readonly vp: { width: number; height: number }
    private readonly headless: boolean
    private readonly startUrl: string
    private readonly snapRadius: number
    private readonly generateId: () => string
    private readonly now: () => string

    private browser: Browser | null = null
    private context: BrowserContext | null = null
    /** The tab currently controlled by capture/execute. */
    private page: Page | null = null
    /** Prevent duplicate close listeners when Playwright reports the first page twice. */
    private readonly trackedPages = new WeakSet<Page>()
    /** Interactive elements from the most recent capture, for click snapping. */
    private lastElements: DomElement[] = []
    /** Monotonic tab topology/selection generation; it never rolls back. */
    private pageEpoch = 0
    /** Bind the latest observation to the exact tab and lifecycle it described. */
    private lastObservation: { id: string; page: Page; epoch: number } | null = null

    /** Promote newly opened tabs/popups to the active tab and track their lifecycle. */
    private readonly onContextPage = (page: Page): void => {
        this.trackPage(page)
    }

    constructor(deps: BrowserEnvironmentDeps = {}) {
        this.vp = deps.viewport ?? { width: 1280, height: 800 }
        this.headless = deps.headless ?? false
        this.startUrl = deps.startUrl ?? 'about:blank'
        this.snapRadius = deps.snapRadius ?? 60
        this.generateId = deps.generateId ?? defaultGenerateId
        this.now = deps.now ?? (() => new Date().toISOString())
    }

    /** Launch Chromium and open the first page. Safe to call repeatedly. */
    async start(): Promise<void> {
        if (this.browser) return
        // Lazy + external import so the app only touches Playwright on demand.
        const { chromium } = await import('playwright')
        // Zero-setup launch chain. A packaged download has no Playwright
        // browser cache, so after the managed Chromium (present on dev
        // machines) we drive the browsers people already have via Playwright
        // channels: Chrome, then Edge, then Brave/Chromium at their standard
        // macOS paths. No downloads, no terminal steps.
        const attempts: Array<{ label: string } & Parameters<typeof chromium.launch>[0]> = [
            { label: 'Playwright-managed Chromium' },
            { label: 'Google Chrome', channel: 'chrome' },
            { label: 'Microsoft Edge', channel: 'msedge' },
            {
                label: 'Brave',
                executablePath: '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
            },
            {
                label: 'Chromium.app',
                executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium'
            }
        ]
        let lastError: unknown = null
        for (const { label, ...options } of attempts) {
            try {
                this.browser = await chromium.launch({ ...options, headless: this.headless })
                break
            } catch (err) {
                lastError = err
                console.warn(`[browser-env] launch via ${label} failed; trying next option`)
            }
        }
        if (!this.browser) {
            throw new Error(
                'Browser Use needs a Chromium-based browser. Install Google Chrome ' +
                '(or Microsoft Edge) and try again.',
                { cause: lastError ?? undefined }
            )
        }
        this.context = await this.browser.newContext({
            viewport: { width: this.vp.width, height: this.vp.height }
        })
        this.context.on('page', this.onContextPage)
        const firstPage = await this.context.newPage()
        this.trackPage(firstPage)
        try {
            await firstPage.goto(this.startUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        } catch {
            // A slow/blocked start URL must not fail the launch; the agent can
            // navigate itself from a blank page.
        }
    }

    /** Close the browser and release resources. Safe when already stopped. */
    async stop(): Promise<void> {
        const browser = this.browser
        const context = this.context
        if (context) context.off('page', this.onContextPage)
        this.page = null
        this.context = null
        this.browser = null
        this.lastElements = []
        this.lastObservation = null
        if (browser) await browser.close().catch(() => undefined)
    }

    /** The browser viewport is the coordinate space for Coordinate_Mapping (Req 25.1). */
    viewport(): EnvironmentViewport {
        return { width: this.vp.width, height: this.vp.height, scaleFactor: 1 }
    }

    /** Healthy once at least one browser tab is open. */
    async health(): Promise<EnvironmentHealth> {
        if (this.activePage() && this.browser) return { available: true }
        return { available: false, reason: 'browser is not started' }
    }

    /**
     * Screenshot the page and attach its interactive elements for hybrid
     * perception. Coordinate space is the viewport, so the Observation maps 1:1
     * (identity Coordinate_Mapping like the container backend). Fails closed.
     */
    async capture(_options?: CaptureOptions): Promise<PerceptionResult> {
        void _options
        const page = this.activePage()
        if (!page) return this.captureFailed('browser is not started')
        this.lastObservation = null
        try {
            // Playwright does not reliably expose a person clicking between
            // already-open Chromium tabs: all pages can report visible/focused.
            // Make the internally selected page visibly foreground before we
            // describe it, so capture and execution share an explicit target.
            await page.bringToFront()
            if (page.isClosed() || this.activePage() !== page) {
                return this.captureFailed('browser tab changed before capture; capture again')
            }
            const captureEpoch = this.pageEpoch
            // DOM-based perception: no screenshot. We give the model the page's
            // interactive elements (with coordinates) + a readable text digest,
            // so requests are TEXT-ONLY. That runs on text models and sidesteps
            // free vision tiers' rate limits and "no image input" errors. The
            // user watches the real Chromium window for the visual view.
            const raw = await page.evaluate(collectInteractiveElements).catch(() => [])
            this.lastElements = raw.map((e) => ({
                role: e.role,
                title: e.title,
                cx: e.x + e.width / 2,
                cy: e.y + e.height / 2,
                bounds: { x: e.x, y: e.y, width: e.width, height: e.height }
            }))
            const digest = await page
                .evaluate(readPageDigest)
                .catch(() => ({ title: '', url: '', text: '' }))
            const tabDigest = await this.describeTabs(page)
            if (
                page.isClosed() ||
                this.activePage() !== page ||
                this.pageEpoch !== captureEpoch
            ) {
                this.lastElements = []
                this.lastObservation = null
                return this.captureFailed('browser tabs changed during capture; capture again')
            }

            const observation: Observation = {
                id: this.generateId(),
                // Empty => the reasoning request carries no image (text-only).
                screenshotDataUrl: '',
                imageWidth: this.vp.width,
                imageHeight: this.vp.height,
                displayId: 0,
                displayBounds: { x: 0, y: 0, width: this.vp.width, height: this.vp.height },
                scaleFactor: 1,
                pageText: `${tabDigest}\nTitle: ${digest.title}\nURL: ${minimizePageUrl(digest.url)}\n\n${digest.text}`.trim(),
                complete: true,
                capturedAt: this.now()
            }
            if (this.lastElements.length > 0) {
                observation.a11yElements = this.lastElements.map((e) => ({
                    role: e.role,
                    title: e.title,
                    bounds: e.bounds
                }))
            }
            this.lastObservation = { id: observation.id, page, epoch: captureEpoch }
            return { ok: true, observation }
        } catch (err) {
            return this.captureFailed(
                `browser capture failed: ${err instanceof Error ? err.message : String(err)}`
            )
        }
    }

    /**
     * Validate + map the Action, then realize it through Playwright. Coordinate
     * clicks snap to the nearest interactive element center so near-misses still
     * hit their target. Records an ActionResult for every attempt; never throws.
     */
    async execute(
        rawAction: Action,
        observation: Observation,
        meta: { highRisk?: boolean; confirmed?: boolean } = {}
    ): Promise<ActionResult> {
        const executedAt = this.now()
        const base = { highRisk: meta.highRisk ?? false, confirmed: meta.confirmed, executedAt }

        const selected = this.activePage()
        if (!selected) return { status: 'failure', reason: 'browser is not started', ...base }

        const binding = this.lastObservation
        if (!binding || binding.id !== observation.id) {
            return {
                status: 'failure',
                reason: 'browser observation is stale; capture the current tab again',
                ...base
            }
        }
        if (
            binding.page.isClosed() ||
            selected !== binding.page ||
            binding.epoch !== this.pageEpoch
        ) {
            this.lastElements = []
            this.lastObservation = null
            return {
                status: 'failure',
                reason: 'browser tabs changed since the observation; capture again',
                ...base
            }
        }
        const page = binding.page

        // Every submitted action consumes its observation, including a
        // validation/mapping rejection. A retry must use a fresh capture.
        this.lastObservation = null
        const pre = preflightAction(rawAction, observation)
        if (!pre.ok) {
            const status: ActionResult['status'] = pre.stage === 'validation' ? 'rejected' : 'failure'
            return { status, reason: pre.detail, ...base }
        }

        try {
            // Best-effort foregrounding makes ordinary execution watchable, but
            // Chromium cannot atomically lock a tab against a person's click.
            // The safety invariant is exact-Page targeting: even if the user
            // switches during an awaited operation, Playwright still acts only
            // on the Page represented by this observation, never another tab.
            await page.bringToFront()
            if (
                page.isClosed() ||
                this.activePage() !== page ||
                binding.epoch !== this.pageEpoch
            ) {
                throw new Error('browser tabs changed before execution; capture again')
            }
            const mode = await this.realize(page, pre.action)
            // A tab action may close or replace `page`; settle whichever tab is
            // active now so successful browser-chrome actions are not reported as
            // failures merely because their originating Page was closed.
            const settlePage = this.activePage()
            if (settlePage) await settlePage.waitForTimeout(250)
            return { status: 'success', mode, ...base }
        } catch (err) {
            return {
                status: 'failure',
                reason: err instanceof Error ? err.message : String(err),
                ...base
            }
        }
    }

    /**
     * Perform one mapped Action against the active tab and report how it was
     * realized. Browser-tab shortcuts are interpreted by the environment (the
     * page itself cannot focus browser chrome). Form submission is validated
     * against native HTML constraints before Enter or a submit-control click.
     */
    private async realize(page: Page, action: Action): Promise<'api' | 'vision'> {
        switch (action.kind) {
            case 'screenshot':
                return 'api'
            case 'wait':
                await page.waitForTimeout(Math.max(0, Math.min(action.ms, 10_000)))
                return 'api'
            case 'mouse_move': {
                const s = this.snap(action.at)
                await page.mouse.move(s.point.x, s.point.y)
                return s.snapped ? 'api' : 'vision'
            }
            case 'left_click': {
                const s = this.snap(action.at)
                await this.assertFormCanSubmitAt(page, s.point)
                await page.mouse.click(s.point.x, s.point.y)
                return s.snapped ? 'api' : 'vision'
            }
            case 'right_click': {
                const s = this.snap(action.at)
                await page.mouse.click(s.point.x, s.point.y, { button: 'right' })
                return s.snapped ? 'api' : 'vision'
            }
            case 'double_click': {
                const s = this.snap(action.at)
                await this.assertFormCanSubmitAt(page, s.point)
                await page.mouse.dblclick(s.point.x, s.point.y)
                return s.snapped ? 'api' : 'vision'
            }
            case 'drag': {
                await page.mouse.move(action.from.x, action.from.y)
                await page.mouse.down()
                await page.mouse.move(action.to.x, action.to.y, { steps: 8 })
                await page.mouse.up()
                return 'vision'
            }
            case 'type':
                // The browser address bar is CHROME, not page content, so it is
                // unreachable via keyboard/coordinates. A URL navigates the
                // active tab directly; ordinary text fills the focused DOM field.
                if (looksLikeUrl(action.text)) {
                    await page.goto(normalizeUrl(action.text), {
                        waitUntil: 'domcontentloaded',
                        timeout: 20_000
                    })
                    return 'api'
                }
                if (!(await this.fillFocusedField(page, action.text))) {
                    await page.keyboard.type(action.text)
                }
                return 'api'
            case 'key':
                if (await this.handleTabShortcut(page, action.keys)) return 'api'
                if (isEnterChord(action.keys)) await this.assertActiveFormCanSubmit(page)
                await page.keyboard.press(mapKeyChord(action.keys))
                return 'api'
            case 'scroll': {
                const s = this.snap(action.at)
                await page.mouse.move(s.point.x, s.point.y)
                await page.mouse.wheel(action.dx, action.dy)
                return s.snapped ? 'api' : 'vision'
            }
        }
    }

    /** Register a page once, promote it, and invalidate prior tab snapshots. */
    private trackPage(page: Page): void {
        const isNewPage = !this.trackedPages.has(page)
        const selectionChanged = this.page !== page
        if (isNewPage || selectionChanged) {
            this.pageEpoch += 1
            this.lastElements = []
            this.lastObservation = null
        }
        this.page = page
        if (!isNewPage) return

        this.trackedPages.add(page)
        page.once('close', () => {
            // Any close changes tab topology permanently, even if a transient
            // popup closes and selection returns to the Page observed earlier.
            this.pageEpoch += 1
            this.lastElements = []
            this.lastObservation = null
            if (this.page === page) this.page = this.lastOpenPage()
        })
    }

    /** Return the internally selected open tab, with a most-recent fallback. */
    private activePage(): Page | null {
        if (this.page && !this.page.isClosed()) return this.page
        const fallback = this.lastOpenPage()
        if (fallback !== this.page) {
            this.pageEpoch += 1
            this.lastElements = []
            this.lastObservation = null
            this.page = fallback
        }
        return this.page
    }

    private openPages(): Page[] {
        return (this.context?.pages() ?? []).filter((page) => !page.isClosed())
    }

    private lastOpenPage(): Page | null {
        const pages = this.openPages()
        return pages.length > 0 ? pages[pages.length - 1] : null
    }

    /** Add bounded, origin-only tab metadata. */
    private async describeTabs(active: Page): Promise<string> {
        const pages = this.openPages()
        const activeIndex = Math.max(0, pages.indexOf(active))
        const visiblePages = pages
            .slice(0, 8)
            .map((page, index) => ({ page, index }))
        if (activeIndex >= 8 && visiblePages.length > 0) {
            // Keep the digest bounded but always include the page actions will
            // target, replacing the last inactive summary when necessary.
            visiblePages[visiblePages.length - 1] = { page: active, index: activeIndex }
        }
        const summaries = await Promise.all(
            visiblePages.map(async ({ page, index }) => {
                const isActive = page === active
                const marker = isActive ? '*' : '-'
                const url = minimizePageUrl(page.url())
                if (!isActive) return `${marker} ${index + 1}: inactive tab — ${url}`
                const title = (await page.title().catch(() => ''))
                    .replace(/\s+/g, ' ')
                    .trim()
                    .slice(0, 120)
                return `${marker} ${index + 1}: ${title || '(untitled)'} — ${url}`
            })
        )
        const omitted = pages.length > summaries.length ? `\n- … ${pages.length - summaries.length} more` : ''
        return `Browser tabs: ${pages.length}; active tab: ${activeIndex + 1}\n${summaries.join('\n')}${omitted}`
    }

    /** Handle browser-chrome tab commands using the existing key Action. */
    private async handleTabShortcut(sourcePage: Page, keys: string[]): Promise<boolean> {
        const shortcut = classifyTabShortcut(keys)
        if (!shortcut || !this.context) return false

        const pages = this.openPages()
        const active = sourcePage.isClosed() ? null : sourcePage
        const activeIndex = active ? Math.max(0, pages.indexOf(active)) : 0

        if (shortcut.kind === 'new') {
            const page = await this.context.newPage()
            this.trackPage(page)
            await page.bringToFront()
            return true
        }

        if (shortcut.kind === 'close') {
            if (!active) return true
            if (pages.length === 1) {
                await active.goto('about:blank').catch(() => undefined)
                this.lastElements = []
                return true
            }
            const fallback = pages[activeIndex + 1] ?? pages[activeIndex - 1]
            await active.close()
            if (fallback && !fallback.isClosed()) {
                this.trackPage(fallback)
                await fallback.bringToFront()
            }
            return true
        }

        if (pages.length === 0) return true
        let targetIndex: number
        if (shortcut.kind === 'index') {
            targetIndex = shortcut.index === 8 ? pages.length - 1 : Math.min(shortcut.index, pages.length - 1)
        } else {
            const delta = shortcut.kind === 'next' ? 1 : -1
            targetIndex = (activeIndex + delta + pages.length) % pages.length
        }
        const target = pages[targetIndex]
        this.trackPage(target)
        await target.bringToFront()
        this.lastElements = []
        return true
    }

    /** Use Playwright's DOM fill for focused editable controls. */
    private async fillFocusedField(page: Page, text: string): Promise<boolean> {
        const editable = await page.evaluate(() => {
            const element = document.activeElement
            if (!(element instanceof HTMLElement)) return false
            if (element.isContentEditable) return true
            if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly
            if (!(element instanceof HTMLInputElement)) return false
            const nonTextTypes = new Set([
                'button',
                'checkbox',
                'color',
                'file',
                'hidden',
                'image',
                'radio',
                'range',
                'reset',
                'submit'
            ])
            return !element.disabled && !element.readOnly && !nonTextTypes.has(element.type.toLowerCase())
        })
        if (!editable) return false
        await page.locator(':focus').fill(text)
        return true
    }

    /** Fail before clicking a native submit control when its form is invalid. */
    private async assertFormCanSubmitAt(page: Page, point: Point): Promise<void> {
        const result = await page.evaluate(({ x, y }) => {
            const none = { attempted: false, valid: true, fields: [] as string[] }
            const hit = document.elementFromPoint(x, y)
            const control = hit?.closest('button,input')
            if (!(control instanceof HTMLButtonElement || control instanceof HTMLInputElement)) {
                return none
            }
            if (control.disabled) return none

            const isSubmit =
                (control instanceof HTMLButtonElement && control.type === 'submit') ||
                (control instanceof HTMLInputElement &&
                    (control.type === 'submit' || control.type === 'image'))
            const form = control.form
            if (!isSubmit || !form || form.noValidate || control.formNoValidate) return none

            const valid = form.checkValidity()
            const fields = Array.from(form.querySelectorAll(':invalid'))
                .slice(0, 4)
                .map((node) => {
                    const element = node as HTMLInputElement
                    return (
                        element.getAttribute('aria-label') ||
                        element.getAttribute('name') ||
                        element.getAttribute('placeholder') ||
                        element.id ||
                        element.tagName.toLowerCase()
                    )
                })
            if (!valid) form.reportValidity()
            return { attempted: true, valid, fields }
        }, point)
        this.throwIfInvalidForm(result)
    }

    /** Fail before Enter only when it would natively submit an invalid form. */
    private async assertActiveFormCanSubmit(page: Page): Promise<void> {
        const result = await page.evaluate(() => {
            const none = { attempted: false, valid: true, fields: [] as string[] }
            const active = document.activeElement
            if (!(active instanceof HTMLElement)) return none
            if (active instanceof HTMLTextAreaElement || active.isContentEditable) return none

            let form: HTMLFormElement | null = null
            let submitter: HTMLButtonElement | HTMLInputElement | null = null
            if (active instanceof HTMLButtonElement) {
                if (active.disabled || active.type !== 'submit') return none
                form = active.form
                submitter = active
            } else if (active instanceof HTMLInputElement) {
                if (active.disabled) return none
                form = active.form
                if (!form) return none

                if (active.type === 'submit' || active.type === 'image') {
                    submitter = active
                } else {
                    const implicitTypes = new Set([
                        'text',
                        'search',
                        'tel',
                        'url',
                        'email',
                        'password',
                        'date',
                        'month',
                        'week',
                        'time',
                        'datetime-local',
                        'number'
                    ])
                    if (!implicitTypes.has(active.type)) return none

                    const submitters = Array.from(form.elements).filter(
                        (element): element is HTMLButtonElement | HTMLInputElement =>
                            (element instanceof HTMLButtonElement &&
                                !element.disabled &&
                                element.type === 'submit') ||
                            (element instanceof HTMLInputElement &&
                                !element.disabled &&
                                (element.type === 'submit' || element.type === 'image'))
                    )
                    submitter = submitters[0] ?? null
                    if (!submitter) {
                        const blockingFields = Array.from(form.elements).filter(
                            (element) =>
                                element instanceof HTMLInputElement &&
                                !element.disabled &&
                                implicitTypes.has(element.type)
                        )
                        if (blockingFields.length > 1) return none
                    }
                }
            } else {
                return none
            }

            if (!form || form.noValidate || submitter?.formNoValidate) return none
            const valid = form.checkValidity()
            const fields = Array.from(form.querySelectorAll(':invalid'))
                .slice(0, 4)
                .map((node) => {
                    const element = node as HTMLInputElement
                    return (
                        element.getAttribute('aria-label') ||
                        element.getAttribute('name') ||
                        element.getAttribute('placeholder') ||
                        element.id ||
                        element.tagName.toLowerCase()
                    )
                })
            if (!valid) form.reportValidity()
            return { attempted: true, valid, fields }
        })
        this.throwIfInvalidForm(result)
    }

    private throwIfInvalidForm(result: {
        attempted: boolean
        valid: boolean
        fields: string[]
    }): void {
        if (!result.attempted || result.valid) return
        const detail = result.fields.length > 0 ? ` Missing or invalid: ${result.fields.join(', ')}.` : ''
        throw new Error(`Form submission blocked until required fields are valid.${detail}`)
    }

    /**
     * Snap a coordinate to the nearest interactive element center within
     * {@link snapRadius}. Returns whether a snap happened so the caller can
     * report `api` (hit a real element) vs `vision` (raw coordinate).
     */
    private snap(at: Point): { point: Point; snapped: boolean } {
        let best: DomElement | null = null
        let bestDist = this.snapRadius
        for (const el of this.lastElements) {
            const d = Math.hypot(el.cx - at.x, el.cy - at.y)
            if (d <= bestDist) {
                bestDist = d
                best = el
            }
        }
        return best ? { point: { x: best.cx, y: best.cy }, snapped: true } : { point: at, snapped: false }
    }

    private captureFailed(message: string): PerceptionResult {
        const error: OperatorError = {
            kind: 'capture-failed',
            message,
            recoverable: true,
            action: 'retry'
        }
        return { ok: false, reason: 'capture-failed', pause: true, error }
    }
}

/**
 * True when the typed text is a URL or bare domain the agent means to navigate
 * to (e.g. `https://youtube.com`, `youtube.com`, `www.google.com/search`).
 * Search queries and form text (no dot-TLD, spaces) are not treated as URLs.
 */
function looksLikeUrl(text: string): boolean {
    const t = text.trim()
    if (t.length === 0 || /\s/.test(t)) return false
    if (/^https?:\/\//i.test(t)) return true
    // bare domain: label(.label)+ with a TLD, optional path/query.
    return /^[a-z0-9-]+(\.[a-z0-9-]+)+(\/[^\s]*)?$/i.test(t)
}

/** Prefix a bare domain with https:// so Playwright's goto accepts it. */
function normalizeUrl(text: string): string {
    const t = text.trim()
    return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

type TabShortcut =
    | { kind: 'new' }
    | { kind: 'close' }
    | { kind: 'next' }
    | { kind: 'previous' }
    | { kind: 'index'; index: number }

/** Recognize browser-tab shortcuts that page.keyboard cannot send to Chromium chrome. */
function classifyTabShortcut(keys: readonly string[]): TabShortcut | null {
    const normalized = new Set(keys.map((key) => key.trim().toLowerCase()))
    const primary =
        normalized.has('cmd') ||
        normalized.has('command') ||
        normalized.has('meta') ||
        normalized.has('ctrl') ||
        normalized.has('control')
    if (!primary) return null

    if (normalized.has('t') && !normalized.has('shift')) return { kind: 'new' }
    if (normalized.has('w') && !normalized.has('shift')) return { kind: 'close' }
    if (
        normalized.has('pagedown') ||
        (normalized.has(']') && normalized.has('shift')) ||
        (normalized.has('tab') && !normalized.has('shift'))
    ) {
        return { kind: 'next' }
    }
    if (
        normalized.has('pageup') ||
        (normalized.has('[') && normalized.has('shift')) ||
        (normalized.has('tab') && normalized.has('shift'))
    ) {
        return { kind: 'previous' }
    }

    for (let digit = 1; digit <= 9; digit += 1) {
        if (normalized.has(String(digit))) return { kind: 'index', index: digit - 1 }
    }
    return null
}

function isEnterChord(keys: readonly string[]): boolean {
    return keys.some((key) => {
        const normalized = key.trim().toLowerCase()
        return normalized === 'enter' || normalized === 'return'
    })
}

/**
 * Map an Action_Space key chord onto Playwright's key names, joining a chord
 * with `+` (e.g. `["cmd","c"]` -> `Meta+c`). Common aliases are normalized so
 * models that emit `cmd`/`ctrl`/`return`/`esc` all work.
 */
function mapKeyChord(keys: string[]): string {
    const ALIASES: Record<string, string> = {
        cmd: 'Meta',
        command: 'Meta',
        meta: 'Meta',
        ctrl: 'Control',
        control: 'Control',
        opt: 'Alt',
        option: 'Alt',
        alt: 'Alt',
        shift: 'Shift',
        enter: 'Enter',
        return: 'Enter',
        esc: 'Escape',
        escape: 'Escape',
        tab: 'Tab',
        space: 'Space',
        backspace: 'Backspace',
        delete: 'Delete',
        up: 'ArrowUp',
        down: 'ArrowDown',
        left: 'ArrowLeft',
        right: 'ArrowRight'
    }
    return keys
        .map((k) => {
            const lower = k.toLowerCase()
            if (ALIASES[lower]) return ALIASES[lower]
            // Single letters/digits pass through; longer tokens are Capitalized.
            return k.length === 1 ? k : k.charAt(0).toUpperCase() + k.slice(1)
        })
        .join('+')
}
