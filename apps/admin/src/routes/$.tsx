import { createFileRoute, Link } from '@tanstack/react-router'

export const Route = createFileRoute('/$')({
	component: NotFound,
})

function NotFound() {
	return (
		<div className="flex items-center justify-center h-full">
			<div className="text-center">
				<p className="text-6xl font-bold text-zinc-800">404</p>
				<p className="text-zinc-500 mt-2">Page not found</p>
				<Link
					to="/"
					className="inline-block mt-4 px-4 py-2 bg-zinc-100 rounded text-sm hover:bg-zinc-200 transition-colors"
				>
					Back to Dashboard
				</Link>
			</div>
		</div>
	)
}
