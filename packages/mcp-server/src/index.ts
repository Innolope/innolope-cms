#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { InnolopeClient } from './api-client.js'
import { registerTools, SERVER_INSTRUCTIONS } from './register-tools.js'

const apiUrl = process.env.INNOLOPE_API_URL
const apiKey = process.env.INNOLOPE_API_KEY
// Optional. A project-scoped key already carries its project; an account-scoped
// key or a session that will call create_project/use_project can start without one.
const projectId = process.env.INNOLOPE_PROJECT_ID

if (!apiUrl || !apiKey) {
	console.error('Missing required environment variables: INNOLOPE_API_URL, INNOLOPE_API_KEY')
	process.exit(1)
}

const client = new InnolopeClient(apiUrl, apiKey, projectId)

const server = new McpServer(
	{
		name: 'innolope-cms',
		version: '0.1.0',
	},
	{ instructions: SERVER_INSTRUCTIONS },
)

registerTools(server, client)

const transport = new StdioServerTransport()
await server.connect(transport)
