/** @typedef {import('../types.js').InstallOptions} InstallOptions */

/** Shared across copies of this module, so a later `install` can find an earlier one's queue */
const MARKER = Symbol.for('devalue.uneval-stream');

/**
 * The state each message's `fn` receives as `s`. Its shape is a protocol shared with the
 * output of `unevalStream`, so changing it is a breaking change.
 */
function create_state() {
	const s = {
		/** @type {unknown[]} */
		o: [],
		/** @type {Array<[(value: unknown) => void, (reason: unknown) => void]>} */
		p: [],
		/** @param {number} i */
		d(i) {
			const promise = new Promise((resolve, reject) => {
				s.p[i] = [resolve, reject];
			});
			// prevents unhandled rejections before user code attaches handlers
			promise.catch(() => {});
			return promise;
		},
		/** @param {number} i @param {0 | 1} k @param {unknown} v */
		r(i, k, v) {
			s.p[i][k](v);
			// `delete` rather than `splice`, so `a` skips promises that have settled
			delete s.p[i];
		},
		f() {
			return new Error('devalue: failed to serialize asynchronous value');
		},
		a() {
			s.p.forEach((p) => p[1](new Error('devalue: stream aborted')));
		}
	};
	return s;
}

/** @param {unknown} error */
function report(error) {
	if (typeof reportError === 'function') {
		reportError(error);
	} else {
		queueMicrotask(() => {
			throw error;
		});
	}
}

/**
 * Handles the messages pushed by `unevalStream`'s `head` and `tail`, whether they were pushed
 * before this call or are pushed after it. Call it again on the same location to replace
 * `receive` and `done`.
 * @param {InstallOptions} options
 */
export function install({ target = globalThis, key = '__d', receive, done }) {
	const location = /** @type {Record<PropertyKey, any>} */ (target);
	const queue = location[key];

	if (queue !== undefined && !Array.isArray(queue)) {
		/** @type {typeof handlers | undefined} */
		const existing = queue?.[MARKER];
		if (existing === undefined) throw new Error('devalue: scope is already in use');
		existing.receive = receive;
		existing.done = done;
		return;
	}

	// Read at call time, so a later `install` (from any copy of this module) can replace them
	const handlers = { receive, done };

	/** @type {Map<string, { state: ReturnType<typeof create_state>, deliver: (value: unknown) => void }>} */
	const streams = new Map();

	/** @param {string} id */
	function end(id) {
		streams.delete(id);
		try {
			handlers.done?.(id);
		} catch (error) {
			report(error);
		}
	}

	/**
	 * Handles a message from the server: `fn` is called with the stream's state and its
	 * `receive` callback, and returns 1 when it's the stream's last
	 * @param {[id: string, fn: (s: ReturnType<typeof create_state>, n: (value: unknown) => void) => unknown]} message
	 */
	function handle([id, fn]) {
		let stream = streams.get(id);
		const first = stream === undefined;
		if (stream === undefined) {
			/** @param {unknown} value */
			const deliver = (value) => {
				try {
					handlers.receive(id, value);
				} catch (error) {
					report(error);
				}
			};

			streams.set(id, (stream = { state: create_state(), deliver }));
		}

		try {
			if (fn(stream.state, stream.deliver) === 1) end(id);
		} catch (error) {
			// a stray message must not leave a poisoned state behind for its id
			if (first) streams.delete(id);
			report(error);
		}
	}

	if (queue !== undefined) {
		// by index, so messages pushed while the queue is being handled are handled in order
		for (let i = 0; i < queue.length; i += 1) handle(queue[i]);
	}

	location[key] = {
		[MARKER]: handlers,
		/** @param {Parameters<typeof handle>[0][]} messages */
		push(...messages) {
			for (const message of messages) handle(message);
		}
	};
}
