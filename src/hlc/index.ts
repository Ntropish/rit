export interface HlcTimestamp {
  wallTime: number;
  logical: number;
  nodeId: string;
}

export class HybridLogicalClock {
  private wallTime: number;
  private logical: number;
  readonly nodeId: string;

  constructor(nodeId: string, wallTime: number = 0, logical: number = 0) {
    this.nodeId = nodeId;
    this.wallTime = wallTime;
    this.logical = logical;
  }

  /** Local event: advance the clock and return a new timestamp. */
  tick(): HlcTimestamp {
    const now = Date.now();
    if (now > this.wallTime) {
      this.wallTime = now;
      this.logical = 0;
    } else {
      this.logical++;
    }
    return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId };
  }

  /** Merge with a remote timestamp: advance past both local and remote. */
  receive(remote: HlcTimestamp): HlcTimestamp {
    const now = Date.now();
    const maxWall = Math.max(this.wallTime, remote.wallTime, now);

    if (maxWall === this.wallTime && maxWall === remote.wallTime && maxWall === now) {
      // All three equal
      this.logical = Math.max(this.logical, remote.logical) + 1;
    } else if (maxWall === this.wallTime && maxWall === remote.wallTime) {
      // Local and remote tied at max, now is behind
      this.logical = Math.max(this.logical, remote.logical) + 1;
    } else if (maxWall === this.wallTime && maxWall === now) {
      // Local and now tied at max, remote is behind
      this.logical = this.logical + 1;
    } else if (maxWall === remote.wallTime && maxWall === now) {
      // Remote and now tied at max, local is behind
      this.logical = remote.logical + 1;
    } else if (maxWall === this.wallTime) {
      // Only local is at max
      this.logical = this.logical + 1;
    } else if (maxWall === remote.wallTime) {
      // Only remote is at max
      this.logical = remote.logical + 1;
    } else {
      // Only now is at max (clock jumped forward)
      this.logical = 0;
    }

    this.wallTime = maxWall;
    return { wallTime: this.wallTime, logical: this.logical, nodeId: this.nodeId };
  }

  /** Compare two HLC timestamps for total ordering. Returns -1, 0, or 1. */
  static compare(a: HlcTimestamp, b: HlcTimestamp): -1 | 0 | 1 {
    if (a.wallTime !== b.wallTime) return a.wallTime < b.wallTime ? -1 : 1;
    if (a.logical !== b.logical) return a.logical < b.logical ? -1 : 1;
    if (a.nodeId < b.nodeId) return -1;
    if (a.nodeId > b.nodeId) return 1;
    return 0;
  }

  /** Generate a random 16-char hex nodeId. */
  static generateNodeId(): string {
    const bytes = new Uint8Array(8);
    crypto.getRandomValues(bytes);
    let hex = '';
    for (let i = 0; i < bytes.length; i++) {
      hex += bytes[i].toString(16).padStart(2, '0');
    }
    return hex;
  }
}
