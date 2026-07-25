/**
 * Build id injected by vite.config.ts `define`. Absent under the dev server
 * and in tests — read it through `typeof` checks (see lib/build-version.ts).
 */
declare const __BUILD_ID__: string | undefined
