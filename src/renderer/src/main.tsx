import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
// Geist (Vercel) — bundled offline via @fontsource-variable, before styles.css so the
// @font-face rules (and their bundled woff2) are registered when the tokens reference them.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
