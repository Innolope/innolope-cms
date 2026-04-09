import type { FastifyInstance } from 'fastify'
import fp from 'fastify-plugin'
import {
	type EmailAdapter,
	type EmailMessage,
	ConsoleEmailAdapter,
	ResendEmailAdapter,
	SmtpEmailAdapter,
} from '../services/email.js'

declare module 'fastify' {
	interface FastifyInstance {
		email: EmailAdapter
	}
}

export const emailPlugin = fp(async (app: FastifyInstance) => {
	let adapter: EmailAdapter

	if (process.env.RESEND_API_KEY) {
		adapter = new ResendEmailAdapter(
			process.env.RESEND_API_KEY,
			process.env.EMAIL_FROM || 'Innolope CMS <noreply@innolope.com>',
		)
		app.log.info('Email adapter: resend')
	} else if (process.env.SMTP_HOST) {
		adapter = new SmtpEmailAdapter({
			host: process.env.SMTP_HOST,
			port: Number(process.env.SMTP_PORT) || 587,
			user: process.env.SMTP_USER || '',
			pass: process.env.SMTP_PASS || '',
			from: process.env.EMAIL_FROM || 'Innolope CMS <noreply@innolope.com>',
		})
		app.log.info('Email adapter: smtp')
	} else {
		adapter = new ConsoleEmailAdapter()
		app.log.info('Email adapter: console (no RESEND_API_KEY or SMTP_HOST set)')
	}

	app.decorate('email', adapter)
})
