import assert from 'node:assert/strict';
import test from 'node:test';
import { WorldCoordinate, type AxisDirection } from '../game/world/coordinate.js';

const movementCases: ReadonlyArray<{
  direction: AxisDirection;
  expected: WorldCoordinate;
}> = [
  { direction: 'north', expected: new WorldCoordinate(4, -1, 7) },
  { direction: 'south', expected: new WorldCoordinate(4, -3, 7) },
  { direction: 'east', expected: new WorldCoordinate(5, -2, 7) },
  { direction: 'west', expected: new WorldCoordinate(3, -2, 7) },
  { direction: 'up', expected: new WorldCoordinate(4, -2, 8) },
  { direction: 'down', expected: new WorldCoordinate(4, -2, 6) },
];

for (const { direction, expected } of movementCases) {
  test(`moves one unit ${direction} without changing the source coordinate`, () => {
    const start = new WorldCoordinate(4, -2, 7);

    assert.deepEqual(start.move(direction), expected);
    assert.deepEqual(start, new WorldCoordinate(4, -2, 7));
  });
}

test('requires integer values on every coordinate axis', () => {
  assert.throws(() => new WorldCoordinate(0.5, 0, 0), /x must be an integer/);
  assert.throws(() => new WorldCoordinate(0, Number.NaN, 0), /y must be an integer/);
  assert.throws(() => new WorldCoordinate(0, 0, Number.POSITIVE_INFINITY), /z must be an integer/);
  assert.throws(() => new WorldCoordinate(Number.MAX_SAFE_INTEGER + 1, 0, 0), /x must be an integer/);
});
