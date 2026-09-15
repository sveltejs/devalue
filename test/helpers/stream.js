import vm from 'node:vm';

/**
 * A fresh VM realm per test, with optional injected built-ins or constructors.
 *
 * @param {Record<string, unknown>} [extra] values to expose inside the realm
 */
export function client(extra = {}) {
	const context = vm.createContext({ ...extra });
	context.globalThis = context;
	context.__window = context;
	return {
		context,
		/** Evaluates a head expression and returns its root value. */
		head: (source) => vm.runInContext(`(${source})`, context),
		/** Evaluates a tail block's statements. */
		block: (source) => vm.runInContext(source, context),
		/** Evaluates a head and all blocks as one concatenated function body. */
		combined: (head, blocks) =>
			vm.runInContext(`(function(){const root=(${head});${blocks.join('')};return root})()`, context)
	};
}

/** Evaluates the head, consumes every tail block, and returns root, blocks, and the client. */
export async function drain(result, target = client()) {
	const root = target.head(result.head);
	const blocks = [];
	for await (const block of result.tail) {
		blocks.push(block);
		target.block(block);
	}
	return { root, blocks, client: target };
}
