import type { TurnCapture } from '@shared/types'

const MAX_VIDEO_BYTES = 250 * 1024 * 1024
const MAX_VIDEO_FRAMES = 12
const FRAME_INTERVAL_SECONDS = 4
const MAX_FRAME_EDGE = 1280
const LOAD_TIMEOUT_MS = 20_000
const SEEK_TIMEOUT_MS = 12_000

export interface ExtractedVideo {
    captures: TurnCapture[]
    durationSeconds: number
}

function waitForMediaEvent(
    video: HTMLVideoElement,
    eventName: 'loadedmetadata' | 'loadeddata' | 'seeked',
    timeoutMs: number
): Promise<void> {
    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const cleanup = (): void => {
            video.removeEventListener(eventName, onReady)
            video.removeEventListener('error', onError)
            if (timer) clearTimeout(timer)
        }
        const onReady = (): void => {
            cleanup()
            resolve()
        }
        const onError = (): void => {
            cleanup()
            reject(new Error('The video could not be decoded. Try an MP4, MOV, or WebM file.'))
        }
        timer = setTimeout(() => {
            cleanup()
            reject(new Error('The video took too long to decode.'))
        }, timeoutMs)
        video.addEventListener(eventName, onReady, { once: true })
        video.addEventListener('error', onError, { once: true })
    })
}

async function seekVideo(video: HTMLVideoElement, timeSeconds: number): Promise<void> {
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && Math.abs(video.currentTime - timeSeconds) < 0.01) {
        return
    }
    const ready = waitForMediaEvent(video, 'seeked', SEEK_TIMEOUT_MS)
    video.currentTime = timeSeconds
    await ready
}

/**
 * MediaRecorder WebM files commonly omit duration metadata. Chromium discovers
 * the real end time after a far seek, so recover it before choosing frame times.
 */
function readVideoDuration(video: HTMLVideoElement): Promise<number> {
    if (Number.isFinite(video.duration) && video.duration > 0) {
        return Promise.resolve(video.duration)
    }

    return new Promise((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const events: Array<keyof HTMLMediaElementEventMap> = ['durationchange', 'timeupdate', 'seeked']
        const cleanup = (): void => {
            for (const eventName of events) video.removeEventListener(eventName, inspectDuration)
            video.removeEventListener('error', onError)
            if (timer) clearTimeout(timer)
        }
        const finish = (durationSeconds: number): void => {
            cleanup()
            video.currentTime = 0
            resolve(durationSeconds)
        }
        const inspectDuration = (): void => {
            if (Number.isFinite(video.duration) && video.duration > 0) {
                finish(video.duration)
                return
            }
            // Some WebM builds clamp currentTime to the real end while keeping
            // duration infinite. That clamped position is an equivalent bound.
            if (
                Number.isFinite(video.currentTime) &&
                video.currentTime > 0.01 &&
                video.currentTime < Number.MAX_SAFE_INTEGER
            ) {
                finish(video.currentTime)
            }
        }
        const onError = (): void => {
            cleanup()
            reject(new Error('The video duration could not be read.'))
        }
        for (const eventName of events) video.addEventListener(eventName, inspectDuration)
        video.addEventListener('error', onError, { once: true })
        timer = setTimeout(() => {
            cleanup()
            reject(new Error('The video duration could not be read.'))
        }, SEEK_TIMEOUT_MS)

        try {
            video.currentTime = Number.MAX_SAFE_INTEGER
        } catch {
            cleanup()
            reject(new Error('The video duration could not be read.'))
        }
    })
}

function frameTimes(durationSeconds: number): number[] {
    const count = Math.min(
        MAX_VIDEO_FRAMES,
        Math.max(1, Math.ceil(durationSeconds / FRAME_INTERVAL_SECONDS))
    )
    if (count === 1) return [Math.max(0, durationSeconds / 2)]

    // Avoid the exact first/last encoded sample, which is frequently blank.
    const start = Math.min(0.25, durationSeconds * 0.02)
    const end = Math.max(start, durationSeconds - Math.min(0.25, durationSeconds * 0.02))
    return Array.from({ length: count }, (_, index) =>
        start + ((end - start) * index) / (count - 1)
    )
}

function outputSize(width: number, height: number): { width: number; height: number } {
    const scale = Math.min(1, MAX_FRAME_EDGE / Math.max(width, height))
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    }
}

/**
 * Decode a local video and turn it into a bounded chronological image sequence.
 * The raw video never leaves the renderer; the existing vision path receives
 * provider-safe JPEG frames with ordering/timestamp metadata instead.
 */
export async function extractVideoFrames(file: File): Promise<ExtractedVideo> {
    if (file.size <= 0) throw new Error('The selected video is empty.')
    if (file.size > MAX_VIDEO_BYTES) {
        throw new Error('Videos must be 250 MB or smaller.')
    }

    const sourceUrl = URL.createObjectURL(file)
    const video = document.createElement('video')
    video.preload = 'auto'
    video.muted = true
    video.playsInline = true

    try {
        const metadataReady = waitForMediaEvent(video, 'loadedmetadata', LOAD_TIMEOUT_MS)
        video.src = sourceUrl
        video.load()
        await metadataReady

        if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
            await waitForMediaEvent(video, 'loadeddata', LOAD_TIMEOUT_MS)
        }
        const durationSeconds = await readVideoDuration(video)
        if (video.videoWidth <= 0 || video.videoHeight <= 0) {
            throw new Error('The video has no readable picture track.')
        }

        const size = outputSize(video.videoWidth, video.videoHeight)
        const canvas = document.createElement('canvas')
        canvas.width = size.width
        canvas.height = size.height
        const context = canvas.getContext('2d', { alpha: false })
        if (!context) throw new Error('Video frame extraction is unavailable on this device.')

        const times = frameTimes(durationSeconds)
        const sequenceId = typeof crypto.randomUUID === 'function'
            ? crypto.randomUUID()
            : `video-${Date.now()}-${Math.random().toString(36).slice(2)}`
        const captures: TurnCapture[] = []
        for (const [index, timestampSeconds] of times.entries()) {
            await seekVideo(video, timestampSeconds)
            context.drawImage(video, 0, 0, size.width, size.height)
            const dataUrl = canvas.toDataURL('image/jpeg', 0.84)
            captures.push({
                dataUrl,
                thumbnailUrl: dataUrl,
                rect: { x: 0, y: 0, width: size.width, height: size.height },
                videoFrame: {
                    sequenceId,
                    sourceName: file.name,
                    index: index + 1,
                    count: times.length,
                    timestampSeconds,
                    durationSeconds
                }
            })
        }

        return { captures, durationSeconds }
    } finally {
        video.pause()
        video.removeAttribute('src')
        video.load()
        URL.revokeObjectURL(sourceUrl)
    }
}

export function formatMediaDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '0:00'
    const wholeSeconds = Math.round(seconds)
    const minutes = Math.floor(wholeSeconds / 60)
    const remaining = String(wholeSeconds % 60).padStart(2, '0')
    return `${minutes}:${remaining}`
}
