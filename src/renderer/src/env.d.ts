/// <reference types="vite/client" />
import type { DetailedHTMLProps, HTMLAttributes } from 'react'

declare global {
  /** injected at build time from package.json (electron.vite.config.ts) */
  const __APP_VERSION__: string
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      /** Electron <webview> tag (webviewTag: true) hosting Playwright's own UIs */
      webview: DetailedHTMLProps<
        HTMLAttributes<HTMLElement> & {
          src?: string
          partition?: string
          allowpopups?: string
        },
        HTMLElement
      >
    }
  }
}
