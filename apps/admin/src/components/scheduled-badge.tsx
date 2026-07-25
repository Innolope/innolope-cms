import { useTranslation } from 'react-i18next'
import { absoluteDate, relativeTime } from '../lib/relative-time'
import { ClockIcon } from './icons'

/**
 * Marks a record whose publish date is still in the future.
 *
 * Purely a signal to the editor: the CMS does not defer delivery, so a record
 * flagged here is already served by the API. Whether it actually appears on the
 * site is up to the consumer's query (`publishedAt <= now`).
 */
export function ScheduledBadge({
	date,
	className,
}: {
	date: string | number | Date
	className?: string
}) {
	const { t } = useTranslation()
	return (
		<span
			title={t('common.scheduledFor', { date: absoluteDate(date), relative: relativeTime(date) })}
			className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs bg-surface-alt text-text-secondary whitespace-nowrap ${className ?? ''}`}
		>
			<ClockIcon className="w-3 h-3" />
			{t('common.scheduled')}
		</span>
	)
}
