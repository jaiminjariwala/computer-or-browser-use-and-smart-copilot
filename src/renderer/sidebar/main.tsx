import React from 'react'
import { createRoot } from 'react-dom/client'
// Inter (variable), self-hosted so it works offline and within the renderer CSP.
import '@fontsource-variable/inter'
import { App } from './App'
import './styles.css'

const container = document.getElementById('root')
if (container) {
    createRoot(container).render(
        <React.StrictMode>
            <App />
        </React.StrictMode>
    )
}
