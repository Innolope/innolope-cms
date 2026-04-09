export interface EmailMessage {
	to: string
	subject: string
	html: string
	text?: string
}

export interface EmailAdapter {
	send(message: EmailMessage): Promise<void>
}

// --- Console Adapter (dev — prints to stdout) ---

export class ConsoleEmailAdapter implements EmailAdapter {
	async send(message: EmailMessage): Promise<void> {
		console.log(`\n📧 Email to: ${message.to}`)
		console.log(`   Subject: ${message.subject}`)
		console.log(`   ${message.text || message.html.slice(0, 200)}...\n`)
	}
}

// --- Resend Adapter ---

export class ResendEmailAdapter implements EmailAdapter {
	private apiKey: string
	private from: string

	constructor(apiKey: string, from = 'Innolope CMS <noreply@innolope.com>') {
		this.apiKey = apiKey
		this.from = from
	}

	async send(message: EmailMessage): Promise<void> {
		const res = await fetch('https://api.resend.com/emails', {
			method: 'POST',
			headers: {
				'Content-Type': 'application/json',
				Authorization: `Bearer ${this.apiKey}`,
			},
			body: JSON.stringify({
				from: this.from,
				to: message.to,
				subject: message.subject,
				html: message.html,
				text: message.text,
			}),
		})

		if (!res.ok) {
			const err = await res.json().catch(() => ({}))
			throw new Error(`Resend error: ${(err as { message?: string }).message || res.statusText}`)
		}
	}
}

// --- SMTP Adapter (Nodemailer) ---

export class SmtpEmailAdapter implements EmailAdapter {
	private config: {
		host: string
		port: number
		user: string
		pass: string
		from: string
		secure: boolean
	}

	constructor(config: { host: string; port: number; user: string; pass: string; from: string; secure?: boolean }) {
		this.config = { ...config, secure: config.secure ?? config.port === 465 }
	}

	async send(message: EmailMessage): Promise<void> {
		// Dynamic import to avoid bundling nodemailer if not used
		const nodemailer = await import('nodemailer')
		const transport = nodemailer.createTransport({
			host: this.config.host,
			port: this.config.port,
			secure: this.config.secure,
			auth: { user: this.config.user, pass: this.config.pass },
		})

		await transport.sendMail({
			from: this.config.from,
			to: message.to,
			subject: message.subject,
			html: message.html,
			text: message.text,
		})
	}
}

// --- Email Templates ---

export function passwordResetEmail(resetUrl: string, name: string): EmailMessage & { subject: string; html: string; text: string } {
	return {
		to: '', // filled by caller
		subject: 'Reset your Innolope CMS password',
		html: `
			<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
				<h2 style="font-size: 20px; font-weight: 600; color: #111; margin-bottom: 16px;">Reset your password</h2>
				<p style="color: #555; font-size: 14px; line-height: 1.6;">Hi ${name},</p>
				<p style="color: #555; font-size: 14px; line-height: 1.6;">Click the button below to reset your password. This link expires in 1 hour.</p>
				<a href="${resetUrl}" style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500; margin: 20px 0;">Reset Password</a>
				<p style="color: #999; font-size: 12px; margin-top: 24px;">If you didn't request this, ignore this email.</p>
				<hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
				<p style="color: #bbb; font-size: 11px;">Innolope CMS</p>
			</div>
		`,
		text: `Hi ${name},\n\nReset your password: ${resetUrl}\n\nThis link expires in 1 hour.\n\nIf you didn't request this, ignore this email.`,
	}
}

export function teamInviteEmail(inviteUrl: string, inviterName: string, projectName: string, role: string): EmailMessage & { subject: string; html: string; text: string } {
	return {
		to: '', // filled by caller
		subject: `${inviterName} invited you to ${projectName} on Innolope CMS`,
		html: `
			<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 480px; margin: 0 auto; padding: 40px 20px;">
				<h2 style="font-size: 20px; font-weight: 600; color: #111; margin-bottom: 16px;">You've been invited</h2>
				<p style="color: #555; font-size: 14px; line-height: 1.6;">${inviterName} invited you to join <strong>${projectName}</strong> as <strong>${role}</strong>.</p>
				<a href="${inviteUrl}" style="display: inline-block; background: #111; color: #fff; padding: 12px 24px; border-radius: 6px; text-decoration: none; font-size: 14px; font-weight: 500; margin: 20px 0;">Accept Invite</a>
				<p style="color: #999; font-size: 12px; margin-top: 24px;">This invite expires in 7 days.</p>
				<hr style="border: none; border-top: 1px solid #eee; margin: 24px 0;" />
				<p style="color: #bbb; font-size: 11px;">Innolope CMS</p>
			</div>
		`,
		text: `${inviterName} invited you to join "${projectName}" as ${role}.\n\nAccept: ${inviteUrl}\n\nThis invite expires in 7 days.`,
	}
}
