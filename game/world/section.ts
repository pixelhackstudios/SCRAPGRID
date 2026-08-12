import { WorldCoordinate } from './coordinate.js';

/** A place in SCRAPGRID's world, identified by its WorldCoordinate. */
export class WorldSection {
  readonly coordinate: WorldCoordinate;
  readonly id: string;

  constructor(coordinate: WorldCoordinate) {
    this.coordinate = coordinate;
    this.id = WorldSection.idFor(coordinate);
  }

  static idFor(coordinate: WorldCoordinate): string {
    return `${coordinate.x},${coordinate.y},${coordinate.z}`;
  }
}
