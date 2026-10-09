/**
 * @import { UnevalReplacer, UnevalStreamOptions, UnevalStreamResult } from './types';
 */
import { js, JavaScriptSource } from './javascript-source.js';
import { analyze } from './uneval.js';
import { call_replacer, get_type, stringify_string } from './utils.js';

const RESERVED = ['s', 'n'];
const FAILED = 'new Error("devalue: failed to serialize asynchronous value")';
const DONE = Object.freeze({ done: /** @type {true} */ (true), value: undefined });
const identifier = /^[_$a-zA-Z][_$a-zA-Z0-9]*$/;
const then = Promise.prototype.then;
const noop = () => {};
// Bounds UTF-8 serialized property/bracket text, independently of numeric slot width.
const MAX_PATH_COST = 128;

/**
 * Turn a value containing promises into a JavaScript expression (`head`) that
 * recreates it with pending promises, and a stream of statement blocks (`tail`)
 * that settle them as they settle on the server.
 * @param {any} value
 * @param {UnevalReplacer} [replacer]
 * @param {UnevalStreamOptions} [options]
 * @returns {UnevalStreamResult}
 */
export function unevalStream(value, replacer, options = {}) {
	if (options.signal?.aborted) throw options.signal.reason;
	const scope = options.scope ?? 'globalThis.__d';
	const id = options.id ?? random_id();
	const key = stringify_string(id);
	const session = new Session(replacer, options, `${scope}[${key}]`);
	const head = start(session, value, scope, key);
	return { head, tail: session, id };
}

/**
 * Emits the head for a new session. Assigned inside `Session` so it can reach private state.
 * @type {(session: Session, value: any, scope: string, key: string) => string}
 */
let start;

/** Persistent request state is owned here, never by the input-bearing setup scope. */
class Session {
	static {
		start = (session, value, scope, key) => session.#start(value, scope, key);
	}

	/**
	 * @param {UnevalReplacer | undefined} replacer
	 * @param {UnevalStreamOptions} options
	 * @param {string} table
	 */
	constructor(replacer, options, table) {
		this.#replacer = replacer;
		this.#onerror = options.onerror;
		this.#signal = options.signal;
		this.#table = table;
		this.#on_abort = this.#abort_stream.bind(this);
	}

	/** @type {UnevalReplacer | undefined} */
	#replacer;
	/** @type {UnevalStreamOptions['onerror']} */
	#onerror;
	/** @type {AbortSignal | undefined} */
	#signal;
	/** @type {string} */
	#table;
	/** @type {() => void} */
	#on_abort;

	/**
	 * @param {any} value
	 * @param {string} scope
	 * @param {string} key
	 * @returns {string}
	 */
	#start(value, scope, key) {
		this.#signal?.addEventListener('abort', this.#on_abort);

		let head;
		try {
			head = this.#emit_value(value, true);
		} catch (error) {
			this.#finish();
			throw error;
		}

		// Aborted mid-emission: the head is dead on arrival, so fail like a pre-aborted signal
		if (this.#abort) throw this.#abort.reason;

		if (this.#pending === 0) {
			this.#finish();
			return head;
		}

		/**
		 * Wrap the head in an IIFE that sets up this stream's client-side state:
		 * - `n` is the shared `scope` table, created with a null prototype if missing
		 * - `s` is this stream's entry in `n`, keyed by `id`:
		 *   - `s.o` holds slots for objects and primitives that later tail blocks reference
		 *   - `s.p` holds the `[resolve, reject]` pair for each pending promise
		 * - `s.d(i)` creates deferred pending promise `i`, saving its resolvers in `s.p`. The
		 *   no-op `catch` prevents unhandled rejections before user code attaches handlers
		 * - `s.r(i, k, v)` settles promise `i` with `v`, resolving when `k` is 0 and
		 *   rejecting when `k` is 1, then drops its resolvers
		 * The head expression is then evaluated with `s` in scope
		 */
		return (
			`(()=>{let n=${scope}||(${scope}={__proto__:null}),s=(n[${key}]={o:[],p:[]});` +
			`s.d=(i)=>{let p=new Promise((a,b)=>{s.p[i]=[a,b]});p.catch(()=>{});return p};` +
			`s.r=(i,k,v)=>{s.p[i][k](v);delete s.p[i]};` +
			`return ${head}})()`
		);
	}

	/**
	 * Replacer results retained until termination, so each object is seen once
	 * @type {Map<object, JavaScriptSource | null>}
	 */
	#replacer_cache = new Map();

	/**
	 * Where each object that already exists on the client lives
	 * @type {Map<object, Location>}
	 */
	#known = new Map();

	/**
	 * Slots for long strings and bigints. We can vastly reduce the wire size of payloads
	 * containing repeated strings or bigints (whose textual length is essentially unbounded) by saving them
	 * in a slot, which lets us reuse them with very short syntax.
	 * @type {Map<string | bigint, number>}
	 */
	#primitives = new Map();

	/**
	 * Promise settlements not yet emitted in a tail block
	 * @type {Array<{ index: number, ok: boolean, value: unknown }>}
	 */
	#queue = [];

	#next_slot = 0;
	#next_promise = 0;
	/** The number of pending promises that have been sent to the client but not yet resolved */
	#pending = 0;
	#done = false;

	/**
	 * Clearing `current` when the stream ends prevents our pending promises from retaining no-longer-relevant state.
	 * Without this indirection, the callbacks passed to `then`/`enqueue` could strongly-reference our cache data or
	 * other unrelated stuff, which then can't be garbage-collected until the promise resolves. By passing them a pointer,
	 * we enable ourselves to null out that pointer when the stream is aborted or otherwise ends, which allows GC to occur
	 * even if there are latent promises.
	 * @type {{ current: Session | null }}
	 */
	#delivery = { current: this };

	/**
	 * In order to fulfill the AsyncIterableIterator contract (and avoid accidentally sending results out of order),
	 * we use a chain of promises to force subsequent calls to `#next` to resolve in the original call order.
	 */
	#chain = Promise.resolve();

	/**
	 * Resumes a `next()` waiting for a settlement or for the session to finish
	 * @type {(value?: unknown) => void}
	 */
	#wake = noop;

	/** @type {{ reason: unknown } | null} */
	#abort = null;

	/**
	 * @param {any} value
	 * @param {boolean} head
	 */
	#emit_value(value, head) {
		const known = this.#known;
		const replacer_cache = this.#replacer_cache;
		const primitives = this.#primitives;
		const replacer = this.#replacer;
		const slot_start = this.#next_slot;
		const promise_start = this.#next_promise;

		/** @type {Map<object, Location>} */
		const locations = new Map();
		/** @type {Map<object, number>} */
		const retained = new Map();
		/** @type {Map<object, number>} */
		const fresh = new Map();

		/** @type {Map<string | bigint, number>} */
		const staged_primitives = new Map();
		/** @type {Array<{ slot: number, literal: string }>} */
		const primitive_assignments = [];

		try {
			const analysis = analyze(value, {
				known: (thing) => known.get(thing),
				enter: (thing, parent, key) => {
					let up = null;
					let segment = '';
					if (parent !== undefined) {
						up = /** @type {Location} */ (locations.get(parent));
						if (typeof key === 'number') segment = `[${key}]`;
						else if (key !== undefined && key.length <= MAX_PATH_COST) segment = prop(key);
					}
					const cost = path_cost(segment);
					if (up && segment && up.cost + cost <= MAX_PATH_COST) {
						locations.set(thing, { up, key: segment, cost: up.cost + cost });
					} else {
						const slot = this.#next_slot++;
						locations.set(thing, { up: null, key: slot, cost: 0 });
						// The root is assigned around the whole expression instead.
						if (thing !== value) retained.set(thing, slot);
					}
				},
				replace: (thing) => {
					if (replacer) {
						let source = replacer_cache.get(thing);
						if (source === undefined) {
							source = call_replacer(thing, replacer);
							if (!this.#done) replacer_cache.set(thing, source);
						}
						if (source) return source;
					}
					if (get_type(thing) !== 'Promise' || !is_promise(thing)) return null;
					const index = this.#next_promise++;
					fresh.set(thing, index);
					return JavaScriptSource.from(js`s.d(${index})`);
				},
				reserved: RESERVED
			});

			// a head without promises needs no session at all
			if (head && fresh.size === 0) return analysis.render();

			let code = analysis.render({
				reference: expression,
				retain: (thing) => {
					const slot = retained.get(thing);
					return slot === undefined ? undefined : `s.o[${slot}]`;
				},
				primitive: (thing, literal) => {
					let slot = primitives.get(thing) ?? staged_primitives.get(thing);
					if (slot === undefined) {
						slot = this.#next_slot++;
						staged_primitives.set(thing, slot);
						primitive_assignments.push({ slot, literal });
					}
					return `s.o[${slot}]`;
				}
			});

			const root = locations.get(value);
			if (root !== undefined) code = `(s.o[${root.key}]=${code})`;
			if (primitive_assignments.length) {
				const initializers = primitive_assignments.map(
					({ slot, literal }) => `s.o[${slot}]=${literal}`
				);
				code = `(${initializers.join(',')},${code})`;
			}
			// Trusted callbacks can cancel synchronously during emission. Never publish
			// request state or attach new delivery after terminal cleanup.
			if (!this.#done) {
				for (const [thing, slot] of staged_primitives) primitives.set(thing, slot);
				for (const [thing, location] of locations) known.set(thing, location);
				for (const [promise, index] of fresh) {
					this.#pending += 1;
					Session.#subscribe(promise, index, this.#delivery);
				}
			}

			return code;
		} catch (error) {
			this.#next_slot = slot_start;
			this.#next_promise = promise_start;
			throw error;
		}
	}

	/**
	 * @param {number} index
	 * @param {boolean} ok
	 * @param {unknown} value
	 */
	#enqueue(index, ok, value) {
		if (this.#done) return;
		this.#queue.push({ index, ok, value });
		this.#wake();
	}

	/**
	 * @param {number} index
	 * @param {boolean} ok
	 * @param {unknown} value
	 */
	#settle(index, ok, value) {
		try {
			return `s.r(${index},${ok ? 0 : 1},${this.#emit_value(value, false)})`;
		} catch (error) {
			try {
				this.#onerror?.(error, value);
			} catch {
				// a failing error handler must not break the session
			}
			return `s.r(${index},1,${FAILED})`;
		}
	}

	#finish() {
		if (this.#done) return;
		this.#done = true;
		this.#delivery.current = null;
		this.#signal?.removeEventListener('abort', this.#on_abort);
		this.#known.clear();
		this.#replacer_cache.clear();
		this.#primitives.clear();
		this.#queue.length = 0;
		this.#replacer = undefined;
		this.#onerror = undefined;
		this.#signal = undefined;
		this.#on_abort = noop;
		const wake = this.#wake;
		this.#wake = noop;
		wake();
	}

	#abort_stream() {
		if (this.#done) return;
		this.#abort = { reason: this.#signal?.reason };
		this.#finish();
	}

	/** @returns {Promise<IteratorResult<string, undefined>>} */
	async #step() {
		while (!this.#done && this.#queue.length === 0) {
			await new Promise((resolve) => (this.#wake = resolve));
			this.#wake = noop;
		}

		if (this.#abort) {
			const { reason } = this.#abort;
			this.#abort = null;
			throw reason;
		}

		if (this.#done) return DONE;

		const statements = [];
		for (const { index, ok, value } of this.#queue.splice(0)) {
			this.#pending -= 1;
			statements.push(this.#settle(index, ok, value));
		}

		const complete = this.#pending === 0;
		if (complete) {
			statements.push(`delete ${this.#table}`);
		}

		const value = `((s)=>{${statements.join(';')}})(${this.#table});`;
		if (complete) this.#finish();
		return { done: false, value };
	}

	/** @returns {Promise<IteratorResult<string, undefined>>} */
	next() {
		const result = this.#chain.then(this.#step.bind(this));
		this.#chain = result.then(noop, noop);
		return result;
	}

	/** @returns {Promise<IteratorResult<string, undefined>>} */
	return() {
		this.#finish();
		return Promise.resolve(DONE);
	}

	[Symbol.asyncIterator]() {
		return this;
	}

	/**
	 * Native reactions own only this detachable cell and the numeric index.
	 * @param {object} promise
	 * @param {number} index
	 * @param {{ current: Session | null }} delivery
	 */
	static #subscribe(promise, index, delivery) {
		/**
		 * @param {boolean} ok
		 * @param {unknown} value
		 */
		const deliver = (ok, value) => {
			const session = delivery.current;
			if (session) session.#enqueue(index, ok, value);
		};
		then.call(
			promise,
			(value) => deliver(true, value),
			(error) => deliver(false, error)
		);
	}
}

/** @param {object} thing */
function is_promise(thing) {
	try {
		then.call(thing, noop, noop);
		return true;
	} catch {
		return false;
	}
}

/**
 * A slot (`up` is null and `key` is its expression) or a property of another location
 * Property keys are already serialized, bounded segments; root keys are slot indices.
 * @typedef {{ up: Location | null, key: string | number, cost: number }} Location
 */

/**
 * @param {Location} location
 * @returns {string}
 */
function expression(location) {
	const segments = [];
	while (location.up !== null) {
		segments.push(location.key);
		location = location.up;
	}
	return `s.o[${location.key}]${segments.reverse().join('')}`;
}

/**
 * Count UTF-8 bytes of an already bounded segment or path. Never called on an
 * unbounded property key; slot width is the only uncapped part of a path.
 * @param {string} source
 */
function path_cost(source) {
	let cost = 0;
	for (const character of source) {
		const code = /** @type {number} */ (character.codePointAt(0));
		cost += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
	}
	return cost;
}

/** @param {string} key */
function prop(key) {
	return identifier.test(key) ? `.${key}` : `[${stringify_string(key)}]`;
}

function random_id() {
	return Math.random().toString(36).slice(2, 10);
}
