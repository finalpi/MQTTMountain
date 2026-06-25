type HeavyJobKind = 'query' | 'exclusive';

export interface HeavyJobOptions {
    kind: HeavyJobKind;
    label: string;
    priority?: number;
}

interface QueuedJob<T> {
    id: number;
    kind: HeavyJobKind;
    label: string;
    priority: number;
    run: () => Promise<T> | T;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
    cancelled: boolean;
}

export interface ScheduledHeavyJob<T> {
    promise: Promise<T>;
    cancel: () => void;
}

const MAX_QUERY_JOBS = 2;

let nextJobId = 1;
let activeQueries = 0;
let activeExclusive = false;
const queue: QueuedJob<unknown>[] = [];

function compareJob(a: QueuedJob<unknown>, b: QueuedJob<unknown>): number {
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.id - b.id;
}

function canRun(job: QueuedJob<unknown>): boolean {
    if (job.kind === 'exclusive') return !activeExclusive && activeQueries === 0;
    if (activeExclusive || activeQueries >= MAX_QUERY_JOBS) return false;

    const earlierBlockingExclusive = queue.some((item) => (
        item !== job
        && !item.cancelled
        && item.kind === 'exclusive'
        && (item.priority > job.priority || (item.priority === job.priority && item.id < job.id))
    ));
    return !earlierBlockingExclusive;
}

function activate(job: QueuedJob<unknown>): void {
    if (job.kind === 'exclusive') activeExclusive = true;
    else activeQueries++;

    Promise.resolve()
        .then(job.run)
        .then(job.resolve, job.reject)
        .finally(() => {
            if (job.kind === 'exclusive') activeExclusive = false;
            else activeQueries = Math.max(0, activeQueries - 1);
            drainQueue();
        });
}

function drainQueue(): void {
    queue.sort(compareJob);
    for (;;) {
        const index = queue.findIndex((job) => {
            if (job.cancelled) return false;
            return canRun(job);
        });
        if (index < 0) break;
        const [job] = queue.splice(index, 1);
        activate(job);
    }

    for (let i = queue.length - 1; i >= 0; i--) {
        const job = queue[i];
        if (!job.cancelled) continue;
        queue.splice(i, 1);
        job.reject(new Error(`${job.label} 已取消`));
    }
}

export function scheduleHeavyJob<T>(options: HeavyJobOptions, run: () => Promise<T> | T): ScheduledHeavyJob<T> {
    let queued: QueuedJob<T>;
    const promise = new Promise<T>((resolve, reject) => {
        queued = {
            id: nextJobId++,
            kind: options.kind,
            label: options.label,
            priority: options.priority ?? 0,
            run,
            resolve,
            reject,
            cancelled: false
        };
        queue.push(queued as QueuedJob<unknown>);
        drainQueue();
    });

    return {
        promise,
        cancel: () => {
            queued.cancelled = true;
            drainQueue();
        }
    };
}

export function getHeavyJobSnapshot(): { activeQueries: number; activeExclusive: boolean; queued: number } {
    return {
        activeQueries,
        activeExclusive,
        queued: queue.filter((job) => !job.cancelled).length
    };
}
