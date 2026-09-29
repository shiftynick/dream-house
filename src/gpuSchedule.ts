/** Nonblocking GPU backpressure. A fast caller (or a high-refresh display)
 * cannot queue an unbounded number of refinement tiles ahead of the device. */
export class GpuSchedule {
  private fence: WebGLSync | null = null;
  private submitted = -Infinity;
  private next = 0;
  private pendingTimeout = 12_000;
  private nextTimeout = 12_000;
  constructor(
    private context: WebGL2RenderingContext,
    private interval = 16,
  ) {}
  ready(now: number, timeoutMs = 12_000) {
    if (this.context.isContextLost() || now < this.next) return false;
    if (this.fence) {
      // Shader compilation may finish before the queued draw/fence completes.
      // Never retroactively shorten the allowance granted to this GPU batch.
      this.pendingTimeout = Math.max(this.pendingTimeout, timeoutMs);
      const result = this.context.clientWaitSync(this.fence, 0, 0);
      if (result === this.context.WAIT_FAILED)
        throw new Error('The graphics device could not finish refinement.');
      if (result === this.context.TIMEOUT_EXPIRED) {
        if (now - this.submitted > this.pendingTimeout)
          throw new Error('The graphics device took too long to finish refinement.');
        return false;
      }
      this.context.deleteSync(this.fence);
      this.fence = null;
    }
    this.next = now + this.interval;
    this.nextTimeout = timeoutMs;
    return true;
  }
  submittedFrame(now: number) {
    if (this.context.isContextLost()) return;
    this.fence = this.context.fenceSync(this.context.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.submitted = now;
    this.pendingTimeout = this.nextTimeout;
    this.context.flush();
  }
  dispose() {
    if (this.fence) this.context.deleteSync(this.fence);
    this.fence = null;
    this.next = 0;
    this.pendingTimeout = this.nextTimeout = 12_000;
  }
}
