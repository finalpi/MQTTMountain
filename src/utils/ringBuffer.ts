/**
 * 高性能环形缓冲区。
 * - O(1) push；满时自动覆盖最旧
 * - 通过 `version` 方便外部判断是否有变化（Vue 响应式友好）
 * - `snapshot()` 返回按写入顺序（旧 → 新）的数组副本
 */
export class RingBuffer<T> {
    private buf: (T | undefined)[];
    private head = 0;
    private size = 0;
    private cap: number;
    public version = 0;
    public total = 0;

    constructor(capacity: number) {
        this.cap = Math.max(1, capacity | 0);
        this.buf = new Array(this.cap);
    }

    get length(): number {
        return this.size;
    }
    get capacity(): number {
        return this.cap;
    }

    setCapacity(capacity: number): void {
        const cap = Math.max(1, capacity | 0);
        if (cap === this.cap) return;
        const snap = this.snapshot();
        this.cap = cap;
        this.buf = new Array(cap);
        this.head = 0;
        this.size = 0;
        const start = Math.max(0, snap.length - cap);
        for (let i = start; i < snap.length; i++) this.push(snap[i]);
    }

    push(v: T): void {
        if (this.size < this.cap) {
            this.buf[(this.head + this.size) % this.cap] = v;
            this.size++;
        } else {
            this.buf[this.head] = v;
            this.head = (this.head + 1) % this.cap;
        }
        this.total++;
        this.version++;
    }

    clear(): void {
        this.buf = new Array(this.cap);
        this.head = 0;
        this.size = 0;
        this.total = 0;
        this.version++;
    }

    at(i: number): T | undefined {
        if (i < 0 || i >= this.size) return undefined;
        return this.buf[(this.head + i) % this.cap];
    }

    last(): T | undefined {
        return this.size ? this.buf[(this.head + this.size - 1) % this.cap] : undefined;
    }

    snapshot(): T[] {
        const out = new Array<T>(this.size);
        for (let i = 0; i < this.size; i++) out[i] = this.buf[(this.head + i) % this.cap] as T;
        return out;
    }

    /** 从新到旧遍历，回调返回 false 终止 */
    forEachReverse(cb: (v: T, idx: number) => void | boolean): void {
        for (let i = this.size - 1; i >= 0; i--) {
            const v = this.buf[(this.head + i) % this.cap] as T;
            if (cb(v, i) === false) break;
        }
    }
}
