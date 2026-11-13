import test from 'node:test';
import assert from 'node:assert/strict';
import { glyphTransform, interpolateBox, easeHandMorph, type GlyphBox } from '../src/handMorphGeometry';

function matrix(from: GlyphBox, to: GlyphBox): number[] {
  return glyphTransform(from, to).slice(7, -1).split(',').map(Number);
}
function mapped(box: GlyphBox, m: number[]): GlyphBox {
  return { x: m[0]! * box.x + m[4]!, y: m[3]! * box.y + m[5]!,
    width: m[0]! * box.width, height: m[3]! * box.height };
}
function close(actual: GlyphBox, expected: GlyphBox): void {
  for (const key of ['x', 'y', 'width', 'height'] as const) {
    assert.ok(Math.abs(actual[key] - expected[key]) < 1e-9, `${key}: ${actual[key]} != ${expected[key]}`);
  }
}

for (const [name, from, to] of [
  ['rank', { x: 4, y: 6, width: 12, height: 22 }, { x: 10, y: 5, width: 20, height: 25 }],
  ['suit', { x: 4, y: 30, width: 9.75, height: 14 }, { x: 11, y: 27, width: 14.625, height: 21 }],
] as const) {
  test(`${name}: both font drawings occupy identical bounds throughout the morph, in both directions`, () => {
    for (const [source, target] of [[from, to], [to, from]]) {
      const forward = matrix(source!, target!);
      const reverse = matrix(target!, source!);
      close(mapped(source!, forward), target!);
      close(mapped(target!, reverse), source!);
      for (const progress of [0, .1, .25, .5, .75, .9, 1]) {
        const identity = [1, 0, 0, 1, 0, 0];
        const sourceMatrix = forward.map((value, index) => identity[index]! + (value - identity[index]!) * progress);
        const targetMatrix = reverse.map((value, index) => value + (identity[index]! - value) * progress);
        close(mapped(source!, sourceMatrix), mapped(target!, targetMatrix));
        close(interpolateBox(source!, target!, progress), mapped(source!, sourceMatrix));
      }
    }
  });
}

test('one easing clock moves the card, crop and both fonts together without overshoot', () => {
  assert.equal(easeHandMorph(0),0); assert.equal(easeHandMorph(1),1);
  let previous=0;
  for(let i=0;i<=100;i++) { const p=easeHandMorph(i/100);assert.ok(p>=previous&&p<=1);previous=p; }
});
