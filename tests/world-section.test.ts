import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldCoordinate } from '../game/world/coordinate.js';
import { WorldSection } from '../game/world/section.js';

test('exposes the coordinate it was constructed with', () => {
  const coordinate = new WorldCoordinate(4, -2, 7);
  const section = new WorldSection(coordinate);

  assert.equal(section.coordinate, coordinate);
});

test('two sections at the same coordinate produce the same id', () => {
  const first = new WorldSection(new WorldCoordinate(3, -5, 9));
  const second = new WorldSection(new WorldCoordinate(3, -5, 9));

  assert.equal(first.id, second.id);
});

const distinctCoordinateCases: ReadonlyArray<{
  label: string;
  a: WorldCoordinate;
  b: WorldCoordinate;
}> = [
  { label: 'positive coordinates', a: new WorldCoordinate(1, 2, 3), b: new WorldCoordinate(1, 2, 4) },
  { label: 'negative coordinates', a: new WorldCoordinate(-1, -2, -3), b: new WorldCoordinate(-1, -2, -4) },
  { label: 'zero coordinates', a: new WorldCoordinate(0, 0, 0), b: new WorldCoordinate(0, 0, 1) },
  { label: 'vertical coordinates', a: new WorldCoordinate(0, 0, 5), b: new WorldCoordinate(0, 0, -5) },
];

for (const { label, a, b } of distinctCoordinateCases) {
  test(`different coordinates produce different ids (${label})`, () => {
    const sectionA = new WorldSection(a);
    const sectionB = new WorldSection(b);

    assert.notEqual(sectionA.id, sectionB.id);
  });
}

test('does not confuse coordinates with different digit boundaries', () => {
  const first = new WorldSection(new WorldCoordinate(1, -23, 0));
  const second = new WorldSection(new WorldCoordinate(1, -2, 30));

  assert.notEqual(first.id, second.id);
});
