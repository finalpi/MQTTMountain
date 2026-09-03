import { defineStore } from 'pinia';
import { ref, computed, reactive } from 'vue';
import type { ConnectionConfig, SubscriptionConfig, MqttProtocol } from '@shared/types';
import { randomClientId, randomId } from '@/utils/format';

export type ConnState = 'connected' | 'reconnecting' | 'offline' | 'closed' | 'error' | 'idle';

const MQTT_PROTOCOLS = new Set<MqttProtocol>(['mqtt://', 'mqtts://', 'ws://', 'wss://']);

function stringValue(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}

function normalizeSubscriptions(subscriptions: unknown): SubscriptionConfig[] {
    if (!Array.isArray(subscriptions)) return [];
    const seen = new Set<string>();
    const result: SubscriptionConfig[] = [];
    for (const item of subscriptions) {
        if (!item || typeof item !== 'object') continue;
        const topic = String((item as { topic?: unknown }).topic ?? '').trim();
        if (!topic || seen.has(topic)) continue;
        const qosValue = Number((item as { qos?: unknown }).qos);
        const qos: 0 | 1 | 2 = qosValue === 1 || qosValue === 2 ? qosValue : 0;
        const pausedValue = (item as { paused?: unknown }).paused;
        const paused = 'paused' in item
            ? pausedValue === true || (typeof pausedValue === 'string' && pausedValue.trim().toLowerCase() === 'true')
            : undefined;
        seen.add(topic);
        result.push({ topic, qos, paused });
    }
    return result;
}

function normalizeDisabledTopics(disabledTopics: unknown): string[] {
    if (!Array.isArray(disabledTopics)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const item of disabledTopics) {
        const topic = String(item ?? '').trim();
        if (!topic || seen.has(topic)) continue;
        seen.add(topic);
        result.push(topic);
    }
    return result;
}

export function normalizeConnectionConfig(raw: Partial<ConnectionConfig>): ConnectionConfig {
    const protocol = MQTT_PROTOCOLS.has(raw.protocol as MqttProtocol) ? raw.protocol as MqttProtocol : 'mqtt://';
    const port = Number(raw.port);
    return {
        id: String(raw.id ?? randomId()),
        name: stringValue(raw.name, '新连接'),
        protocol,
        host: stringValue(raw.host, 'broker.emqx.io'),
        port: Number.isFinite(port) && port > 0 && port <= 65535 ? Math.trunc(port) : 1883,
        path: stringValue(raw.path, '/mqtt'),
        username: stringValue(raw.username, ''),
        password: stringValue(raw.password, ''),
        clientId: stringValue(raw.clientId, '') || randomClientId(),
        subscriptions: normalizeSubscriptions(raw.subscriptions),
        disabledTopics: normalizeDisabledTopics(raw.disabledTopics),
        createdAt: Number(raw.createdAt) || Date.now(),
        updatedAt: Number(raw.updatedAt) || Date.now()
    };
}

function normalizeConnectionList(connections: ConnectionConfig[]): ConnectionConfig[] {
    const seenIds = new Set<string>();
    const normalized: ConnectionConfig[] = [];
    for (const item of connections) {
        const current = normalizeConnectionConfig(item);
        let id = current.id.trim();
        if (!id || seenIds.has(id)) {
            do {
                id = randomId();
            } while (seenIds.has(id));
            current.id = id;
        }
        seenIds.add(id);
        normalized.push(current);
    }
    return normalized;
}

export const useConnectionStore = defineStore('connection', () => {
    const list = ref<ConnectionConfig[]>([]);
    const selectedId = ref<string | null>(null);
    const states = reactive<Record<string, { state: ConnState; error?: string }>>({});
    const dirty = ref(false);
    let revision = 0;
    let persistChain: Promise<void> = Promise.resolve();

    function touch(): void {
        revision++;
        dirty.value = true;
    }

    const selected = computed<ConnectionConfig | null>(() => list.value.find((c) => c.id === selectedId.value) ?? null);
    const selectedState = computed<ConnState>(() => {
        const id = selectedId.value;
        if (!id) return 'idle';
        return states[id]?.state ?? 'idle';
    });

    async function load(): Promise<void> {
        const r = await window.api.configRead();
        if (r.success && r.data) {
            list.value = normalizeConnectionList(r.data.connections ?? []);
            const persistedSelectedId = r.data.selectedId;
            selectedId.value = persistedSelectedId && list.value.some((item) => item.id === persistedSelectedId)
                ? persistedSelectedId
                : list.value[0]?.id ?? null;
            revision = 0;
            dirty.value = false;
        }
    }

    async function persist(): Promise<void> {
        const saveRevision = revision;
        const plain = JSON.parse(JSON.stringify(list.value)) as ConnectionConfig[];
        const selectedSnapshot = selectedId.value;
        const operation = persistChain
            .catch(() => undefined)
            .then(async () => {
                const r = await window.api.configWrite({ connections: plain, selectedId: selectedSnapshot });
                if (!r.success) throw new Error(r.message || '配置写入失败');
            });
        persistChain = operation.catch(() => undefined);
        await operation;
        if (revision === saveRevision) dirty.value = false;
    }

    function blank(): ConnectionConfig {
        return {
            id: randomId(),
            name: '新连接',
            protocol: 'mqtt://' as MqttProtocol,
            host: 'broker.emqx.io',
            port: 1883,
            path: '/mqtt',
            username: '',
            password: '',
            clientId: randomClientId(),
            subscriptions: [],
            disabledTopics: [],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
    }

    function create(): ConnectionConfig {
        const c = blank();
        list.value.push(c);
        selectedId.value = c.id;
        touch();
        return c;
    }

    function select(id: string): void {
        if (selectedId.value === id || !list.value.some((item) => item.id === id)) return;
        selectedId.value = id;
        touch();
    }

    function remove(id: string): void {
        const idx = list.value.findIndex((c) => c.id === id);
        if (idx < 0) return;
        list.value.splice(idx, 1);
        if (selectedId.value === id) {
            selectedId.value = list.value[0]?.id ?? null;
        }
        delete states[id];
        touch();
    }

    async function duplicate(id: string): Promise<ConnectionConfig | null> {
        const src = list.value.find((c) => c.id === id);
        if (!src) return null;
        const previousSelectedId = selectedId.value;
        const previousDirty = dirty.value;
        const copy: ConnectionConfig = {
            ...src,
            id: randomId(),
            name: src.name + ' · 副本',
            clientId: randomClientId(),
            subscriptions: src.subscriptions.map((subscription) => ({ ...subscription })),
            disabledTopics: [...src.disabledTopics],
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        list.value.push(copy);
        selectedId.value = copy.id;
        touch();
        try {
            await persist();
            return copy;
        } catch (error) {
            const copyIndex = list.value.findIndex((connection) => connection.id === copy.id);
            if (copyIndex >= 0) list.value.splice(copyIndex, 1);
            selectedId.value = previousSelectedId;
            dirty.value = previousDirty;
            throw error;
        }
    }

    function update(id: string, patch: Partial<ConnectionConfig>): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        Object.assign(c, patch, { updatedAt: Date.now() });
        touch();
    }

    function sanitizeConnections(): void {
        const before = JSON.stringify(list.value);
        const normalized = normalizeConnectionList(list.value);
        if (JSON.stringify(normalized) === before) return;
        list.value = normalized;
        if (selectedId.value && !list.value.some((item) => item.id === selectedId.value)) {
            selectedId.value = list.value[0]?.id ?? null;
        }
        touch();
    }

    function addSubscription(id: string, sub: SubscriptionConfig): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        if (c.subscriptions.find((s) => s.topic === sub.topic)) return;
        c.subscriptions.push(sub);
        c.updatedAt = Date.now();
        touch();
    }

    function removeSubscription(id: string, topic: string): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        c.subscriptions = c.subscriptions.filter((s) => s.topic !== topic);
        c.updatedAt = Date.now();
        touch();
    }

    function setSubscriptionPaused(id: string, topic: string, paused: boolean): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        const s = c.subscriptions.find((x) => x.topic === topic);
        if (!s) return;
        s.paused = paused;
        c.updatedAt = Date.now();
        touch();
    }

    function toggleDisableTopic(id: string, topic: string, disabled: boolean): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        const set = new Set(c.disabledTopics);
        if (disabled) set.add(topic); else set.delete(topic);
        c.disabledTopics = [...set];
        c.updatedAt = Date.now();
        touch();
    }

    function setAllSubscriptionsPaused(id: string, paused: boolean): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        let changed = false;
        for (const subscription of c.subscriptions) {
            if (Boolean(subscription.paused) === paused) continue;
            subscription.paused = paused;
            changed = true;
        }
        if (!changed) return;
        c.updatedAt = Date.now();
        touch();
    }

    function setState(id: string, state: ConnState, message?: string): void {
        states[id] = { state, error: message };
    }

    return {
        list,
        selectedId,
        selected,
        selectedState,
        states,
        dirty,
        load,
        persist,
        create,
        select,
        remove,
        duplicate,
        update,
        sanitizeConnections,
        touch,
        addSubscription,
        removeSubscription,
        setSubscriptionPaused,
        setAllSubscriptionsPaused,
        toggleDisableTopic,
        setState
    };
});
