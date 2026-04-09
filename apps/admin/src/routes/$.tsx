import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/$')({
	component: NotFound,
})

function NotFound() {
	return (
		<div className="flex items-center justify-center h-full">
			<div className="text-center">
				<p className="text-6xl font-bold text-text">404</p>
				<p className="text-text-secondary mt-2">Page not found</p>
				<Link
					to="/"
					className="inline-block mt-4 px-4 py-2 bg-btn-secondary rounded text-sm hover:bg-btn-secondary-hover transition-colors"
				>
					Back to Dashboard
				</Link>
			</div>
		</div>
	)
}
