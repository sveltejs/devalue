/**
 * Representative server-rendered data: an array of `length` article records.
 * @param {number} length
 */
export function records(length) {
	return Array.from({ length }, (_, i) => ({
		id: i,
		title: `Article number ${i}`,
		slug: `article-number-${i}`,
		description: `A description of article ${i} with representative content for server-rendered data.`,
		status: i % 3 === 0 ? 'draft' : 'published',
		tags: ['news', 'featured'],
		date: new Date(1700000000000 + i * 86400000),
		author: { id: i % 10, name: `Author ${i % 10}` }
	}));
}
