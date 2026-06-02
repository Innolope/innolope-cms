import { describe, expect, it } from 'vitest'
import { pickTitleField, resolveDisplayTitle } from './display-title'

describe('pickTitleField', () => {
	it('prefers an explicit titleField override', () => {
		expect(
			pickTitleField({ titleField: 'headline', fields: [{ name: 'title', type: 'text' }] }),
		).toBe('headline')
	})

	it('uses exact `title` then exact `name`', () => {
		expect(
			pickTitleField({
				fields: [
					{ name: 'name', type: 'text' },
					{ name: 'title', type: 'text' },
				],
			}),
		).toBe('title')
		expect(pickTitleField({ fields: [{ name: 'name', type: 'text' }] })).toBe('name')
	})

	it('matches camelCase label-bearing fields like `courseName`', () => {
		expect(pickTitleField({ fields: [{ name: 'courseName', type: 'text' }] })).toBe('courseName')
	})

	it('does not match substrings such as `container` or `subname`', () => {
		expect(
			pickTitleField({
				fields: [
					{ name: 'container', type: 'text' },
					{ name: 'subname', type: 'text' },
				],
			}),
			// neither is a whole-word title/name match, so it falls back to the first text field
		).toBe('container')
	})

	it('prefers a localized text field over a plain one', () => {
		expect(
			pickTitleField({
				fields: [
					{ name: 'body', type: 'text' },
					{ name: 'heading2', type: 'text', localized: true } as never,
				],
			}),
		).toBe('heading2')
	})

	it('returns null when there are no fields', () => {
		expect(pickTitleField({ fields: [] })).toBeNull()
		expect(pickTitleField({})).toBeNull()
	})
})

describe('resolveDisplayTitle', () => {
	const collection = { fields: [{ name: 'title', type: 'text' }] }

	it('resolves a plain string title from metadata', () => {
		expect(resolveDisplayTitle({ id: '1', metadata: { title: 'Hello' } }, collection)).toBe('Hello')
	})

	it('resolves a localized title map using the default locale', () => {
		expect(
			resolveDisplayTitle(
				{ id: '1', metadata: { title: { en: 'Hi', uk: 'Привіт' } } },
				collection,
				{
					defaultLocale: 'uk',
				},
			),
		).toBe('Привіт')
	})

	it('falls back to the slug when no title resolves', () => {
		expect(resolveDisplayTitle({ id: 'abc-123', slug: 'my-post', metadata: {} }, collection)).toBe(
			'my-post',
		)
	})

	it('falls back to the id as a last resort', () => {
		expect(resolveDisplayTitle({ id: 'abc-123', metadata: {} }, collection)).toBe('abc-123')
	})
})
