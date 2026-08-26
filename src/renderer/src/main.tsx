import React from 'react'
import ReactDOM from 'react-dom/client'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/base.css'

// dev-only: fixture-backed wrightbench API for browser-pane pixel checks;
// must install before the stores (imported via App) capture window.wrightbench.
// The DEV guard also tree-shakes the mock out of production bundles.
if (
  import.meta.env.DEV &&
  [
    '#preview-workspace',
    '#preview-codegen',
    '#preview-settings',
    '#preview-reports',
    '#preview-traces',
    '#preview-uimode-error',
    '#preview-detection',
    '#preview-detection-multi',
    '#preview-detection-missing'
  ].includes(window.location.hash) &&
  !window.wrightbench
) {
  const { installMockWrightbench } = await import('./dev/mock-wrightbench')
  installMockWrightbench()
}

const { default: App } = await import('./App')

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
