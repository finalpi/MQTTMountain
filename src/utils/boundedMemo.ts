export class RowMemo<T extends object, V> {
    private key = '';
    private values = new WeakMap<T, V>();

    get(row: T, key: string): V | undefined {
        if (this.key !== key) {
            this.key = key;
            this.values = new WeakMap<T, V>();
        }
        return this.values.get(row);
    }

    set(row: T, key: string, value: V): void {
        if (this.key !== key) {
            this.key = key;
            this.values = new WeakMap<T, V>();
        }
        this.values.set(row, value);
    }

    clear(): void {
        this.key = '';
        this.values = new WeakMap<T, V>();
    }
}

export class BoundedStringMemo<V> {
    private key = '';
    private readonly values = new Map<string, V>();

    constructor(private readonly limit: number) {}

    get(source: string, key: string): V | undefined {
        if (this.key !== key) {
            this.key = key;
            this.values.clear();
            return undefined;
        }
        return this.values.get(source);
    }

    set(source: string, key: string, value: V): void {
        if (this.key !== key) {
            this.key = key;
            this.values.clear();
        }
        if (!this.values.has(source) && this.values.size >= this.limit) {
            const oldest = this.values.keys().next().value;
            if (oldest != null) this.values.delete(oldest);
        }
        this.values.set(source, value);
    }

    clear(): void {
        this.key = '';
        this.values.clear();
    }
}
