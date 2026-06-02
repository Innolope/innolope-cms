import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'

// Explicit cleanup since we don't enable Vitest globals (RTL's auto-cleanup
// only registers when `afterEach` is on globalThis).
afterEach(() => {
	cleanup()
})
