export interface GpuTimingSample {
    //used for discarding returned async old samples before resetting the timer
    epoch: number;
    //used for identifying the frame that generated this sample
    //old frame samples may be returned after a reset, so the frameId is used to discard them
    frameId: number;
    //from first to be marked as pass to last to be marked as pass, including gaps between passes
    rendererGpuMs: number;
    //sum of all passes, excluding gaps between passes
    passBusySumMs: number;
    //key:pass name, value: time spent in that pass, excluding gaps between passes
    passes: Record<string, number>;
}

/** WebGPU timestamp values are nanoseconds; pass sum excludes gaps. */
export function decodeGpuTimestamps(
    values: BigUint64Array,
    names: readonly string[],
    epoch: number,
    frameId: number,
): GpuTimingSample | undefined {
    if (names.length === 0 || values.length !== names.length * 2) {
        return undefined;
    }
    const passes: Record<string, number> = {};
    let passBusySumMs = 0;
    for (let index = 0; index < names.length; index += 1) {
        const start = values[index * 2];
        const end = values[index * 2 + 1];
        if (end < start) return undefined;
        const durationMs = Number(end - start) / 1_000_000;
        if (!Number.isFinite(durationMs)) return undefined;
        passes[names[index]] = durationMs;
        passBusySumMs += durationMs;
    }
    const last = values[values.length - 1];
    if (last < values[0]) return undefined;
    const rendererGpuMs = Number(last - values[0]) / 1_000_000;
    if (!Number.isFinite(rendererGpuMs)) return undefined;
    return { epoch, frameId, rendererGpuMs, passBusySumMs, passes };
}

interface TimerSlot {
    // The query set is used to record timestamps for each pass in a frame.
    querySet: GPUQuerySet;
    // The resolve buffer is used to resolve the query results.
    resolveBuffer: GPUBuffer;
    // The read buffer is used to read back the resolved query results to CPU.
    readBuffer: GPUBuffer;
    state: 'free' | 'pending' | 'mapping' | 'ready';
}

const maxPasses = 8;
//per frame slot,onfly loop buffer slots are benificial for
//CPU waits mapAsync from GPU to get result and limit unlimited readback requests.
const slotCount = 8;
const queryBytes = maxPasses * 2 * BigUint64Array.BYTES_PER_ELEMENT;

/** One bounded readback slot per in-flight measured frame; no render-loop await. */
export class GpuTimer {
    private readonly slots: TimerSlot[];
    private nextSlot = 0;
    //slots are all in use,drop the sample of the frame
    droppedSamples = 0;

    constructor(
        device: GPUDevice,
        //equivalend to add a private readonly onSample field in GpuTimer
        //and pass it to GpuFrameRecorder constructor
        private readonly onSample: (sample: GpuTimingSample) => void,
    ) {
        this.slots = Array.from({ length: slotCount }, (_, index) => ({
            //2 for every passes
            //createQuerySet:the buffer that has to be resolved by GPU and write to a GPUBuffer with QUERY_RESOLVE
            querySet: device.createQuerySet({
                type: 'timestamp', 
                count: maxPasses * 2, 
                label: `profile queries ${index}` 
            }),
            //GPUQuerySet（时间戳槽位）
            //   └─ resolveQuerySet
            //       └─ resolveBuffer [QUERY_RESOLVE | COPY_SRC]
            //           └─ copyBufferToBuffer
            //               └─ readBuffer [COPY_DST | MAP_READ]
            //                   └─ CPU mapAsync 读取 BigUint64Array
            resolveBuffer: device.createBuffer({
                size: queryBytes,
                //QUERY_RESOLVE:can be used as the target of encoder.resolveQuerySet(...)
                usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC,
                label: `profile resolve ${index}`,
            }),
            readBuffer: device.createBuffer({
                size: queryBytes,
                usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
                label: `profile readback ${index}`,
            }),
            state: 'free',
        }));
    }

    begin(epoch: number, frameId: number): GpuFrameRecorder | undefined {
        for (let attempt = 0; attempt < this.slots.length; attempt += 1) {
            const index = (this.nextSlot + attempt) % this.slots.length;
            const slot = this.slots[index];
            if (slot.state === 'free') {
                slot.state = 'pending';
                this.nextSlot = (index + 1) % this.slots.length;
                return new GpuFrameRecorder(slot, epoch, frameId, this.onSample);
            }
        }
        //all slots are in use, drop the sample of the frame
        this.droppedSamples += 1;
        return undefined;
    }
}

export class GpuFrameRecorder {
    //passes names, used to decode the timestamp values after GPU work is done
    private readonly names: string[] = [];
    private resolved = false;

    constructor(
        private readonly slot: TimerSlot,
        private readonly epoch: number,
        private readonly frameId: number,
        private readonly onSample: (sample: GpuTimingSample) => void,
    ) {}

    //schedule 2 timestamp query for every passes.
    //used like:
    //encoder.beginRenderPass({
    //   timestampWrites: gpuFrame?.pass('forward_shading'),
    //})
    pass(name: string): GPUComputePassTimestampWrites {
        if (this.names.length >= maxPasses) {
            throw new Error('GPU profiling pass capacity exceeded');
        }
        const firstQuery = this.names.length * 2;
        this.names.push(name);
        return {
            querySet: this.slot.querySet,
            beginningOfPassWriteIndex: firstQuery,
            endOfPassWriteIndex: firstQuery + 1,
        };
    }
    //querySet → resolveBuffer → readBuffer
    resolve(encoder: GPUCommandEncoder): void {
        if (this.names.length === 0) {
            this.slot.state = 'free';
            return;
        }
        const bytes = this.names.length * 2 * BigUint64Array.BYTES_PER_ELEMENT;
        encoder.resolveQuerySet(this.slot.querySet, 0, this.names.length * 2, this.slot.resolveBuffer, 0);
        encoder.copyBufferToBuffer(this.slot.resolveBuffer, 0, this.slot.readBuffer, 0, bytes);
        this.resolved = true;
    }
    //mapAsync waits till readBuffer is ready to read, then decode the timestamp values and call onSample callback.
    submitted(): void {
        if (!this.resolved) {
            return;
        }
        this.slot.state = 'mapping';
        // mapAsync waits asynchronously for this slot's copy; a full ring drops
        // future measurements instead of building a queue behind GPU work.
        void this.slot.readBuffer.mapAsync(GPUMapMode.READ).then(() => {
            this.slot.state = 'ready';
            //read as 64-bit unsigned integers, each timestamp is 8 bytes, so 2 timestamps per pass
            const values = new BigUint64Array(
                //this.slot.readBuffer.getMappedRange() gets ArrayBuffer of the mapped range, 
                //slice to get only the bytes we need for the passes
                this.slot.readBuffer.getMappedRange().slice(0, this.names.length * 16),
            );
            const sample = decodeGpuTimestamps(values, this.names, this.epoch, this.frameId);
            //call callback
            if (sample) this.onSample(sample);
        }).catch(() => {
            // Device loss or map failure leaves rendering alive; the slot can be reused.
        }).finally(() => {
            //do not forget to unmap the readBuffer, otherwise it will be in mapped state and cannot be reused.
            if (this.slot.readBuffer.mapState === 'mapped') {
                this.slot.readBuffer.unmap();
            }
            this.slot.state = 'free';
        });
    }
}
