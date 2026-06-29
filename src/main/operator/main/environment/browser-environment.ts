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
 *  - `capture()` returns a screenshot (so the existing vision + coordinate
 *    reasoning path works untouched) AND attaches the page's interactive
 *    elements (links, buttons, inputs) as `a11yElements`, each with its on-page
 *    rectangle, so the model is guided by structured page text, not only pixels.
 *  - `execute()` realizes actions through Playwright. Coordinate clicks are
 *    SNAPPED to the nearest interactive element center, so a click that lands a
 *    few pixels off (the usual cause of browser misclicks) still hits the right
 *    control. Typing/keys/scroll go through Playwright's input APIs.
 *
 * Playwright is imported lazily (and is marked `external` in the main build), so
 * the app never loads it unless the user actually selects this environment.
 * Chromium must be installed once via `npx playwright install chromium`.
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
    private page: Page | null = null
    /** Interactive elements from the most recent capture, for click snapping. */
    private lastElements: DomElement[] = []

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
        this.browser = await chromium.launch({ headless: this.headless })
        this.context = await this.browser.newContext({
            viewport: { width: this.vp.width, height: this.vp.height }
        })
        this.page = await this.context.newPage()
        try {
            await this.page.goto(this.startUrl, { waitUntil: 'domcontentloaded', timeout: 15_000 })
        } catch {
            // A slow/blocked start URL must not fail the launch; the agent can
            // navigate itself from a blank page.
        }
    }

    /** Close the browser and release resources. Safe when already stopped. */
    async stop(): Promise<void> {
        const browser = this.browser
        this.page = null
        this.context = null
        this.browser = null
        this.lastElements = []
        if (browser) await browser.close().catch(() => undefined)
    }

    /** The browser viewport is the coordinate space for Coordinate_Mapping (Req 25.1). */
    viewport(): EnvironmentViewport {
        return { width: this.vp.width, height: this.vp.height, scaleFactor: 1 }
    }

    /** Healthy once a page is open. */
    async health(): Promise<EnvironmentHealth> {
        if (this.page && this.browser) return { available: true }
        return { available: false, reason: 'browser is not started' }
    }

    /**
     * Screenshot the page and attach its interactive elements for hybrid
     * perception. Coordinate space is the viewport, so the Observation maps 1:1
     * (identity Coordinate_Mapping like the container backend). Fails closed.
     */
    async capture(_options?: CaptureOptions): Promise<PerceptionResult> {
        void _options
        const page = this.page
        if (!page) return this.captureFailed('browser is not started')
        try {
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

            const observation: Observation = {
                id: this.generateId(),
                // Empty => the reasoning request carries no image (text-only).
                screenshotDataUrl: '',
                imageWidth: this.vp.width,
                imageHeight: this.vp.height,
                displayId: 0,
                displayBounds: { x: 0, y: 0, width: this.vp.width, height: this.vp.height },
                scaleFactor: 1,
                pageText: `Title: ${digest.title}\nURL: ${digest.url}\n\n${digest.text}`.trim(),
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

        const page = this.page
        if (!page) return { status: 'failure', reason: 'browser is not started', ...base }

        const pre = preflightAction(rawAction, observation)
        if (!pre.ok) {
            const status: ActionResult['status'] = pre.stage === 'validation' ? 'rejected' : 'failure'
            return { status, reason: pre.detail, ...base }
        }

        try {
            const mode = await this.realize(page, pre.action)
            // Let the page settle briefly so the next capture reflects the result.
            await page.waitForTimeout(250)
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
     * Perform one mapped Action against the page and report how it was realized:
     * `api` when it acted on a real DOM element (a snapped click, or keyboard
     * input into the page), `vision` when it used raw screen coordinates. This
     * feeds the live api/vision indicator so vision is only credited when the
     * agent truly relied on pixels.
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
                // unreachable via keyboard/coordinates. When the agent types a
                // URL/domain, navigate directly with Playwright's goto (the
                // correct way to "visit a site"); otherwise type into the
                // currently focused page field (search boxes, forms).
                if (looksLikeUrl(action.text)) {
                    await page.goto(normalizeUrl(action.text), {
                        waitUntil: 'domcontentloaded',
                        timeout: 20_000
                    })
                    return 'api'
                }
                await page.keyboard.type(action.text)
                return 'api'
            case 'key':
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
