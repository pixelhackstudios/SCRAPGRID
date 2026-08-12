export type AxisDirection = 'north' | 'south' | 'east' | 'west' | 'up' | 'down';

interface CoordinateDelta {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const DIRECTION_DELTAS: Readonly<Record<AxisDirection, CoordinateDelta>> = {
  north: { x: 0, y: 1, z: 0 },
  south: { x: 0, y: -1, z: 0 },
  east: { x: 1, y: 0, z: 0 },
  west: { x: -1, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  down: { x: 0, y: 0, z: -1 },
};

function requireInteger(axis: string, value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${axis} must be an integer`);
  }
}

/** An immutable position in SCRAPGRID's three-dimensional world. */
export class WorldCoordinate {
  constructor(
    readonly x: number,
    readonly y: number,
    readonly z: number,
  ) {
    requireInteger('x', x);
    requireInteger('y', y);
    requireInteger('z', z);
  }

  move(direction: AxisDirection): WorldCoordinate {
    const delta = DIRECTION_DELTAS[direction];
    return new WorldCoordinate(this.x + delta.x, this.y + delta.y, this.z + delta.z);
  }
}
