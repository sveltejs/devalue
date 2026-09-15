import { describe, test, expect } from 'vitest';
import vm from 'node:vm';
import { js, raw_source } from './javascript-source.js';
import { stringify_primitive } from './utils.js';
import {
	capture_source,
	definitions_source,
	descriptor_source_values,
	describe_received,
	expression_source,
	is_stream_instruction,
	join_sources,
	map_descriptor_source,
	map_source,
	promise_source,
	reference_source,
	render_stream_source_with_names,
	runtime_source,
	source_helpers,
	source_values,
	template_source,
	visit_source_instructions
} from './stream-source.js';

describe('structured stream source', () => {

	/** Test convenience for the real name-aware renderer with its ordinary session binding. */
	function render_stream_source(source, definitions = []) {
		return render_stream_source_with_names(source, definitions, 's', () => {
			throw new TypeError('Unresolved stream identifier: no generated name was assigned before rendering (internal emitter error)');
		});
	}

	test('brands instructions with a private non-enumerable symbol rather than shape', () => {
		const node = /** @type {any} */ ({});
		const source = reference_source(node, { kind: 'anchor', index: 0, segments: [] });
		const instruction = source.values[0];
		expect(is_stream_instruction(instruction)).toBeTruthy();
		expect(Object.keys(instruction)).toEqual(['type', 'node', 'path']);
		const [brand] = Object.getOwnPropertySymbols(instruction);
		expect(instruction[brand]).toBe(true);
		for (const value of [
			{ type: 'reference', node },
			{ type: 'capture', pending: 0, source: raw_source('x') },
			{ type: 'outcome', source: raw_source('x') },
			Object.create({ type: 'reference' })
		]) {
			expect(is_stream_instruction(value)).toBe(false);
		}
	});

	test('keeps nested fragment composition verbatim and groups only expression boundaries', () => {
		const partial = js`Math.max(`;
		const nested = js`${partial}${js`1,2`})`;
		expect(render_stream_source(nested)).toBe('Math.max(1,2)');
		expect(render_stream_source(expression_source(js`1,2`))).toBe('(1,2)');
		expect(render_stream_source(js`[${expression_source(js`1,2`)}]`)).toBe('[(1,2)]');
	});

	test('composes ordered statements without flattening children', () => {
		const source = join_sources(['(()=>{', join_sources([
			js`const a=1`,
			join_sources(['return ', expression_source(js`a,2`)])
		], ';'), '})()']);
		expect(render_stream_source(source)).toBe('(()=>{const a=1;return (a,2)})()');
		expect(render_stream_source(join_sources([js`a`, js`b`, js`c`], ','))).toBe('a,b,c');
	});

	test('renders helper definitions before structured uses', () => {
		const source = join_sources([
			definitions_source(),
			';',
			promise_source(12),
			';',
			runtime_source('r'),
			'(12,0,"0")'
		]);
		const rendered = render_stream_source(source, source_helpers(source));
		expect(rendered.indexOf('s.w=') < rendered.indexOf('s.w(12)')).toBeTruthy();
		expect(rendered.indexOf('s.r=') < rendered.indexOf('s.r(12')).toBeTruthy();
		expect((rendered.match(/s\.w=/g) ?? []).length).toBe(1);
		expect((rendered.match(/\.catch\(\(\)=>\{\}\)/g) ?? []).length).toBe(1);
	});

	test('renders and executes authoritative helpers for short and long session bindings', async () => {
		for (const session of ['s', 'sessionBinding']) {
			const source = join_sources([
				definitions_source(),
				';globalThis.promise=', promise_source(0),
				';', runtime_source('r'), '(0,0,42)',
				';globalThis.anchor=', runtime_source('v'), '("x")'
			]);
			const definitions = source_helpers(source);
			expect(definitions).toEqual(['w', 'r', 'v']);
			const rendered = render_stream_source_with_names(source, definitions, session, () => {
				expect.unreachable('rendered an identifier');
			});
			const context = vm.createContext({ [session]: { a: [], p: [] } });
			context.globalThis = context;
			vm.runInContext(rendered, context);
			expect(await context.promise).toBe(42);
			expect(context.anchor).toBe('x');
			expect(Array.from(context[session].a)).toEqual(['x']);
			expect(rendered.indexOf(`${session}.w=`) < rendered.indexOf(`${session}.w(0)`)).toBeTruthy();
			expect(rendered).toMatch(/new Promise\(\(c,d\)=>/);
		}
	});

	test('groups capture assignments', () => {
		const capture = capture_source(0, js`1,2`);
		expect(render_stream_source(js`f(${capture})`)).toBe('f((s.p[0]=(1,2\n)))');
	});

	test('describes rejected holes without invoking user conversion or inspection hooks', () => {
		const value = {
			get constructor() { expect.unreachable('read constructor'); },
			get [Symbol.toStringTag]() { expect.unreachable('read toStringTag'); },
			[Symbol.toPrimitive]() { expect.unreachable('converted value'); },
			toString() { expect.unreachable('called toString'); }
		};
		expect(() => render_stream_source(js`${value}`)).toThrow(/source rendering: received an object.*internal emitter error/);
		expect(() => render_stream_source(js`${Symbol('data')}`)).toThrow(/received a Symbol.*Symbol values cannot be serialized as data/);
		expect(describe_received(value)).toBe('an object');
		const proxy = Proxy.revocable({}, {});
		proxy.revoke();
		expect(describe_received(proxy.proxy)).toBe('an object');
	});

	test('describes rejected primitive categories without printing user payloads', () => {
		for (const [value, description] of [
			[undefined, 'undefined'], [null, 'null'], [false, 'false'], [true, 'true'],
			[0, 'a number (0)'], [-0, 'a number (-0)'], [NaN, 'a number (NaN)'],
			[1n, 'a bigint'], ['private text', 'a string'], [Symbol('private'), 'a Symbol']
		]) expect(describe_received(value)).toBe(description);
	});

	test('explains unresolved-reference failures', () => {
		expect(() => render_stream_source(reference_source(/** @type {any} */ ({}), undefined))).toThrow(/no assigned anchor, slot, or collection path before rendering.*internal emitter error/);
	});

	test('ordinary instruction-shaped objects remain data holes', () => {
		const inherited = Object.create({ type: 'outcome' });
		const values = [{ type: 'reference' }, { type: 'capture' }, { type: 'outcome' }, inherited];
		expect(source_values(js`${values[0]}${js`${values[1]}`}${values[2]}${inherited}`)).toEqual(values);
	});

	test('collects nested source holes in occurrence order without deduplicating fragments', () => {
		const first = { first: true };
		const second = { second: true };
		const shaped = { type: 'capture', source: js`${{ hidden: false }}` };
		const reused = js`${first},${undefined},${shaped}`;
		const source = js`${js`[${0},${reused}`}${js`,${second},${reused}]`}`;
		expect(source_values(source)).toEqual([0, first, undefined, shaped, second, first, undefined, shaped]);
	});

	test('keeps resolved emission as strings, including expressions and statements', () => {
		expect(join_sources([])).toBe('');
		expect(join_sources([], ',')).toBe('');
		expect(join_sources(['', '', ''], ',')).toBe(',,');
		const object = join_sources(['{value:', join_sources(['1', '2'], '+'), '}']);
		expect(object).toBe('{value:1+2}');
		expect(expression_source(object)).toBe('({value:1+2})');
		const statements = join_sources(['let a=1', join_sources(['a=', expression_source('a,2')])], ';');
		expect(statements).toBe('let a=1;a=(a,2)');
		expect(source_helpers(statements)).toEqual([]);
		let instructions = 0;
		visit_source_instructions(statements, () => instructions++);
		expect(instructions).toBe(0);
		expect(render_stream_source(object)).toBe(object);
	});

	test('retains only structured children when joining text and instructions', () => {
		const pending = promise_source(12);
		const source = join_sources(['{text:', '"0"', ',pending:', pending, ',other:', '"001"', '}']);
		expect(source.strings).toEqual(['{text:"0",pending:', ',other:"001"}']);
		expect(source.values).toEqual([pending]);
		expect(source_helpers(source)).toEqual(['w']);
		expect(render_stream_source(source)).toBe('{text:"0",pending:s.w(12),other:"001"}');
		expect(render_stream_source(join_sources([pending, '"0"', pending], ','))).toBe('s.w(12),"0",s.w(12)');
	});

	test('compiles nested partial templates without confusing data strings with source', () => {
		const text = '</script>"0"';
		const source = js`${js`Math.max(`}${1},${2})`;
		expect(map_source(source, stringify_primitive)).toBe('Math.max(1,2)');
		const compiled = expression_source(map_source(js`{value:${text}}`, stringify_primitive));
		expect(typeof compiled).toBe('string');
		expect(compiled).not.toMatch(/<\/script>/);
		expect(vm.runInNewContext(compiled).value).toBe(text);
		// Only a public descriptor boundary wraps generated text; js string holes remain data.
		expect(render_stream_source(js`${template_source(compiled)}.value`)).toBe(`${compiled}.value`);
		expect(render_stream_source(js`${'1,2'}`)).toBe('"1,2"');
	});

	test('keeps references and helper requests structured when compiling custom templates', () => {
		const node = /** @type {any} */ ({});
		const reference = reference_source(node, { kind: 'slot', index: 0, segments: [] });
		const pending = promise_source(1);
		const source = map_source(js`[${'0'},${reference},${pending}]`, stringify_primitive);
		const instructions = [];
		visit_source_instructions(source, (instruction) => instructions.push(instruction));
		expect(instructions.map((instruction) => instruction.type)).toEqual(['reference', 'promise']);
		let reference_instruction;
		visit_source_instructions(reference, (instruction) => reference_instruction = instruction);
		expect(instructions[0]).toBe(reference_instruction);
		expect(source_helpers(source)).toEqual(['w']);
		expect(render_stream_source(source)).toBe('["0",s.s[0],s.w(1)]');
	});

	test('maps descriptor capture holes without descending into other instructions', () => {
		const data = { value: 1 };
		const capture = capture_source(0, js`[${data},${js`Number(${2})`},${runtime_source('v')}]`);
		const source = map_descriptor_source(js`f(${capture},${'0'})`, (value, index) => {
			if (value === data) return '{value:1}';
			return `${index}:${stringify_primitive(value)}`;
		});
		expect(render_stream_source(source)).toBe('f((s.p[0]=([{value:1},Number(0:2),s.v]\n)),1:"0")');
		expect(source_helpers(source)).toEqual(['v']);
	});

	test('traverses structured dependencies inside capture assignments with textual siblings', () => {
		const capture = capture_source(0, join_sources(['"0",', promise_source(12)]));
		const source = join_sources(['f(', capture, ')']);
		expect(source_helpers(source)).toEqual(['w']);
		expect(render_stream_source(source)).toBe('f((s.p[0]=("0",s.w(12)\n)))');
	});

});
