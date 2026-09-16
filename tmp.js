import { uneval } from './index.js';
import vm from 'node:vm';

class Wrapper {
	constructor(inner, total) {
		this.inner = inner;
		this.total = total;
	}
}

const container = {};
const wrapper = new Wrapper(container, 0);
container.wrapper = wrapper;
const source = uneval([wrapper, wrapper, container], (value, js) => {
	if (value instanceof Wrapper) {
		const a = js.identifier();
		const o0 = js.identifier();
		const result = js.identifier();
		return js`(()=>{const ${a}=1,${o0}=2;const read=({value:${result}},${a})=>${result}+${a};return new Wrapper(${value.inner},read({value:${o0}},${a}))})()`;
	}
});
console.log(source);
const result = vm.runInNewContext(source, { Wrapper });

console.log(result);
