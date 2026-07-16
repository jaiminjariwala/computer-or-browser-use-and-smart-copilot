import React, { useCallback, useEffect, useRef, useState } from 'react'
import { formatMediaDuration } from './video'

interface VideoRecorderProps {
    onRecorded: (file: File) => void
    onClose: () => void
}

type RecorderPhase = 'starting' | 'ready' | 'recording' | 'finishing'

const MAX_RECORDING_SECONDS = 5 * 60
const RECORDER_TYPES = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4'
]

function recorderMimeType(): string | undefined {
    return RECORDER_TYPES.find((type) => MediaRecorder.isTypeSupported(type))
}

function recordingName(mimeType: string): string {
    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm'
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    return `Video recording ${timestamp}.${extension}`
}

function CameraIcon(): React.JSX.Element {
    return (
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="m16 13 4.2 2.8a.5.5 0 0 0 .8-.42V8.62a.5.5 0 0 0-.8-.42L16 11" />
            <rect x="3" y="6" width="13" height="12" rx="3" />
        </svg>
    )
}

export function VideoRecorder({ onRecorded, onClose }: VideoRecorderProps): React.JSX.Element {
    const videoRef = useRef<HTMLVideoElement>(null)
    const streamRef = useRef<MediaStream | null>(null)
    const recorderRef = useRef<MediaRecorder | null>(null)
    const chunksRef = useRef<Blob[]>([])
    const saveOnStopRef = useRef(false)
    const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)
    const mountedRef = useRef(true)
    const [phase, setPhase] = useState<RecorderPhase>('starting')
    const [elapsedSeconds, setElapsedSeconds] = useState(0)
    const [error, setError] = useState<string | null>(null)

    const clearTimer = useCallback(() => {
        if (intervalRef.current) {
            clearInterval(intervalRef.current)
            intervalRef.current = null
        }
    }, [])

    const stopStream = useCallback(() => {
        streamRef.current?.getTracks().forEach((track) => track.stop())
        streamRef.current = null
        if (videoRef.current) videoRef.current.srcObject = null
    }, [])

    useEffect(() => {
        mountedRef.current = true
        if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
            setError('Video recording is not supported on this device. You can still upload a video.')
            return () => {
                mountedRef.current = false
            }
        }

        let cancelled = false
        const openCamera = async (): Promise<void> => {
            try {
                let stream: MediaStream
                try {
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                        audio: true
                    })
                } catch {
                    // Audio is optional. If the combined request is denied or a
                    // microphone is unavailable, retry with camera only; any
                    // second failure is then an accurate camera failure.
                    stream = await navigator.mediaDevices.getUserMedia({
                        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
                        audio: false
                    })
                }
                if (cancelled) {
                    stream.getTracks().forEach((track) => track.stop())
                    return
                }
                streamRef.current = stream
                if (videoRef.current) videoRef.current.srcObject = stream
                setPhase('ready')
            } catch (caught) {
                if (cancelled) return
                const denied = caught instanceof DOMException && caught.name === 'NotAllowedError'
                setError(
                    denied
                        ? 'Camera access is off. Allow camera access in System Settings, then try again.'
                        : caught instanceof Error
                            ? caught.message
                            : 'The camera could not be opened.'
                )
            }
        }
        void openCamera()

        return () => {
            cancelled = true
            mountedRef.current = false
            clearTimer()
            saveOnStopRef.current = false
            const recorder = recorderRef.current
            if (recorder && recorder.state !== 'inactive') {
                recorder.onstop = null
                recorder.stop()
            }
            stopStream()
        }
    }, [clearTimer, stopStream])

    const startRecording = useCallback(() => {
        const stream = streamRef.current
        if (!stream || typeof MediaRecorder === 'undefined') return
        try {
            const mimeType = recorderMimeType()
            const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream)
            chunksRef.current = []
            saveOnStopRef.current = false
            recorder.ondataavailable = (event) => {
                if (event.data.size > 0) chunksRef.current.push(event.data)
            }
            recorder.onerror = () => {
                clearTimer()
                if (mountedRef.current) {
                    setError('Recording stopped unexpectedly. Please try again.')
                    setPhase('ready')
                }
            }
            recorder.onstop = () => {
                clearTimer()
                if (!saveOnStopRef.current || !mountedRef.current) return
                const type = recorder.mimeType || mimeType || 'video/webm'
                const blob = new Blob(chunksRef.current, { type })
                if (blob.size <= 0) {
                    setError('No video was recorded. Please try again.')
                    setPhase('ready')
                    return
                }
                onRecorded(new File([blob], recordingName(type), { type, lastModified: Date.now() }))
                stopStream()
                onClose()
            }
            recorderRef.current = recorder
            recorder.start(1000)
            setElapsedSeconds(0)
            setPhase('recording')
            const startedAt = Date.now()
            intervalRef.current = setInterval(() => {
                const elapsed = Math.floor((Date.now() - startedAt) / 1000)
                setElapsedSeconds(elapsed)
                if (elapsed >= MAX_RECORDING_SECONDS && recorder.state === 'recording') {
                    saveOnStopRef.current = true
                    setPhase('finishing')
                    recorder.stop()
                }
            }, 250)
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : 'Recording could not start.')
        }
    }, [clearTimer, onClose, onRecorded, stopStream])

    const finishRecording = useCallback(() => {
        const recorder = recorderRef.current
        if (!recorder || recorder.state === 'inactive') return
        saveOnStopRef.current = true
        setPhase('finishing')
        recorder.stop()
    }, [])

    const closeAndDiscard = useCallback(() => {
        saveOnStopRef.current = false
        clearTimer()
        const recorder = recorderRef.current
        if (recorder && recorder.state !== 'inactive') {
            recorder.onstop = null
            recorder.stop()
        }
        stopStream()
        onClose()
    }, [clearTimer, onClose, stopStream])

    return (
        <div className="glass-recorder-backdrop" onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeAndDiscard()
        }}>
            <section className="glass-recorder" role="dialog" aria-modal="true" aria-labelledby="video-recorder-title">
                <header className="glass-recorder__header">
                    <span className="glass-recorder__icon"><CameraIcon /></span>
                    <div>
                        <h2 id="video-recorder-title">Record a video</h2>
                        <p>It stays local and is converted to AI-readable frames when attached.</p>
                    </div>
                    <button type="button" className="glass-recorder__close" onClick={closeAndDiscard} aria-label="Close video recorder">×</button>
                </header>

                <div className="glass-recorder__preview">
                    <video ref={videoRef} autoPlay muted playsInline />
                    {phase === 'starting' && !error && <div className="glass-recorder__notice">Starting camera…</div>}
                    {error && <div className="glass-recorder__notice glass-recorder__notice--error">{error}</div>}
                    {phase === 'recording' && (
                        <div className="glass-recorder__live"><span /> REC {formatMediaDuration(elapsedSeconds)}</div>
                    )}
                </div>

                <footer className="glass-recorder__footer">
                    <span className="glass-recorder__privacy">Camera and microphone stop when this window closes.</span>
                    {error ? (
                        <button type="button" className="glass-recorder__secondary" onClick={closeAndDiscard}>Close</button>
                    ) : phase === 'ready' ? (
                        <button type="button" className="glass-recorder__record" onClick={startRecording}>
                            <span /> Start recording
                        </button>
                    ) : phase === 'recording' ? (
                        <button type="button" className="glass-recorder__stop" onClick={finishRecording}>
                            <span /> Stop and attach
                        </button>
                    ) : phase === 'finishing' ? (
                        <button type="button" className="glass-recorder__stop" disabled>Preparing video…</button>
                    ) : null}
                </footer>
            </section>
        </div>
    )
}
