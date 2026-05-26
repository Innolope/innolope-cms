import { createFileRoute, Link } from '@tanstack/react-router'
import { useTranslation } from 'react-i18next'

export const Route = createFileRoute('/$')({
	component: NotFound,
})

function NotFound() {
	const { t } = useTranslation()
	return (
		<div className="flex items-center justify-center h-full">
			<div className="text-center">
				<p className="text-6xl font-bold text-text">{t('notFound.code')}</p>
				<p className="text-text-secondary mt-2">{t('notFound.message')}</p>
				<Link
					to="/"
					className="inline-block mt-4 px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover transition-colors"
				>
					{t('notFound.backToDashboard')}
				</Link>
			</div>
		</div>
	)
}
