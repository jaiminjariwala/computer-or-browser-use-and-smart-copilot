/// <reference types="vite/client" />
import * as pdfjs from 'pdfjs-dist'
// Load the worker via Vite's `?worker` so it is bundled + instantiated as a
// real Worker (a plain `workerSrc` URL is fragile under the renderer CSP and in
// Electron). Passing it as `workerPort` skips pdfjs's own URL fetch entirely.
import PdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?worker'

pdfjs.GlobalWorkerOptions.workerPort = new PdfWorker()

/**
 * Render the first `maxPages` of a PDF file to JPEG data URLs so a PDF the user
 * attaches can be sent to the (vision) gateway as images, the same way
 * screenshots are. Each page is rasterized at a readable width on a white
 * background. Pages beyond the cap are dropped to keep the payload sane.
 */
export async function renderPdfToImages(file: File, maxPages = 5): Promise<string[]> {
    const buffer = await file.arrayBuffer()
    const pdf = await pdfjs.getDocument({ data: new Uint8Array(buffer) }).promise
    const images: string[] = []
    const pageCount = Math.min(pdf.numPages, maxPages)

    for (let pageNum = 1; pageNum <= pageCount; pageNum += 1) {
        const page = await pdf.getPage(pageNum)
        const base = page.getViewport({ scale: 1 })
        // Rasterize to ~1100px wide so text stays legible for the model.
        const scale = 1100 / base.width
        const viewport = page.getViewport({ scale })

        const canvas = document.createElement('canvas')
        canvas.width = Math.ceil(viewport.width)
        canvas.height = Math.ceil(viewport.height)
        const context = canvas.getContext('2d')
        if (!context) continue

        context.fillStyle = '#ffffff'
        context.fillRect(0, 0, canvas.width, canvas.height)
        await page.render({ canvas, canvasContext: context, viewport }).promise
        images.push(canvas.toDataURL('image/jpeg', 0.85))
    }

    return images
}
