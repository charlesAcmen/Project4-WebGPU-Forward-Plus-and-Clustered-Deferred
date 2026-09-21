export interface RollingWindowSnapshot {
  epoch: number;
  sampleCount: number;
  median: number | undefined;
  p95: number | undefined;
}

interface TimedSample {
  timestampMs: number;
  value: number;
}

/**
 * Stores valid samples from a bounded time interval.
 *
 * Callers keep the epoch returned by reset() with asynchronous work. A sample
 * from an older epoch is ignored instead of leaking into the current mode.
 */
export class RollingStatsWindow {
  private readonly durationMs: number;
  private readonly samples: TimedSample[] = [];
  private epoch = 0;
  private latestTimestampMs: number | undefined;
  private dirty = true;
  private cachedMedian: number | undefined;
  private cachedP95: number | undefined;

  constructor(durationMs = 1000) {
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError('durationMs must be a finite positive number');
    }
    this.durationMs = durationMs;
  }

  get currentEpoch(): number {
    return this.epoch;
  }

  addSample(timestampMs: number, value: number, epoch = this.epoch): boolean {
    if (epoch !== this.epoch) {
      return false;
    }

    this.validateTimestamp(timestampMs);
    if (!Number.isFinite(value)) {
      throw new RangeError('sample value must be finite');
    }

    this.latestTimestampMs = timestampMs;
    this.samples.push({ timestampMs, value });
    this.dirty = true;
    this.removeExpiredSamples(timestampMs);
    return true;
  }

  snapshot(timestampMs: number): RollingWindowSnapshot {
    this.validateTimestamp(timestampMs);
    this.latestTimestampMs = timestampMs;
    this.removeExpiredSamples(timestampMs);

    if (this.dirty) {
      const sortedValues = this.samples
        .map((sample) => sample.value)
        .sort((a, b) => a - b);
      this.cachedMedian = median(sortedValues);
      this.cachedP95 = nearestRankPercentile(sortedValues, 0.95);
      this.dirty = false;
    }

    return {
      epoch: this.epoch,
      sampleCount: this.samples.length,
      median: this.cachedMedian,
      p95: this.cachedP95,
    };
  }

  reset(): number {
    this.samples.length = 0;
    this.latestTimestampMs = undefined;
    this.epoch += 1;
    this.dirty = true;
    return this.epoch;
  }

  private removeExpiredSamples(timestampMs: number): void {
    const cutoffMs = timestampMs - this.durationMs;
    while (
      this.samples.length > 0 &&
      this.samples[0].timestampMs < cutoffMs
    ) {
      this.samples.shift();
      this.dirty = true;
    }
  }

  private validateTimestamp(timestampMs: number): void {
    if (!Number.isFinite(timestampMs)) {
      throw new RangeError('timestampMs must be finite');
    }
    if (
      this.latestTimestampMs !== undefined &&
      timestampMs < this.latestTimestampMs
    ) {
      throw new RangeError('timestamps must be nondecreasing');
    }
  }
}

function median(sortedValues: readonly number[]): number | undefined {
  if (sortedValues.length === 0) {
    return undefined;
  }

  const upperIndex = Math.floor(sortedValues.length / 2);
  if (sortedValues.length % 2 === 1) {
    return sortedValues[upperIndex];
  }
  return (sortedValues[upperIndex - 1] + sortedValues[upperIndex]) / 2;
}

/** Uses the nearest-rank definition: rank = ceil(percentile * sample count). */
function nearestRankPercentile(
  sortedValues: readonly number[],
  percentile: number,
): number | undefined {
  if (sortedValues.length === 0) {
    return undefined;
  }

  const rank = Math.ceil(percentile * sortedValues.length);
  return sortedValues[Math.max(0, rank - 1)];
}
