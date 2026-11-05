/** Human-readable progress stays on stderr; never mixed into JSON output. */
export class TurnProgress {
  private timer: ReturnType<typeof setInterval> | undefined;
  private label = '';
  private readonly started = Date.now();

  constructor(
    private readonly enabled: boolean,
    private readonly write: (message: string) => void = console.error,
    private readonly heartbeat = Boolean(process.stderr.isTTY),
  ) {}

  set(label: string): void {
    if (!this.enabled) return;
    if (label !== this.label) {
      this.stop();
      this.label = label;
      this.write(`Wing · ${label}`);
    }
    if (this.heartbeat && !this.timer) {
      this.timer = setInterval(() => {
        this.write(
          `Wing · ${this.label} · 已用时 ${Math.floor((Date.now() - this.started) / 1000)} 秒`,
        );
      }, 15_000);
      this.timer.unref();
    }
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.label = '';
  }
}
