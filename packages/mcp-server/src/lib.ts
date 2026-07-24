/**
 * Library entry point for embedding the Innolope MCP tools in another process
 * (e.g. the API's hosted HTTP transport). Unlike `index.ts`, importing this does
 * NOT start a stdio server — it only exposes the reusable pieces.
 */
export { InnolopeClient } from './api-client.js'
export { registerTools, SERVER_INSTRUCTIONS } from './register-tools.js'
