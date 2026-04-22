import { defineStore } from 'pinia';
import { ref, computed, reactive } from 'vue';
import type { ConnectionConfig, SubscriptionConfig, MqttProtocol } from '@shared/types';
import { randomClientId, randomId } from '@/utils/format';

export type ConnState = 'connected' | 'reconnecting' | 'offline' | 'closed' | 'error' | 'idle';

export const useConnectionStore = defineStore('connection', () => {
    const list = ref<ConnectionConfig[]>([]);
    const selectedId = ref<string | null>(null);
    const states = reactive<Record<string, { state: ConnState; error?: string }>>({});
    const dirty = ref(false);

    const selected = computed<ConnectionConfig | null>(() => list.value.find((c) => c.id === selectedId.value) ?? null);
    const selectedState = computed<ConnState>(() => {
        const id = selectedId.value;
        if (!id) return 'idle';
        return states[id]?.state ?? 'idle';
    });

    async function load(): Promise<void> {
        const r = await window.api.configRead();
        if (r.success && r.data) {
            list.value = r.data.connections ?? [];
            selectedId.value = r.data.selectedId ?? list.value[0]?.id ?? null;
        }
    }

    async function persist(): Promise<void> {
        const plain = JSON.parse(JSON.stringify(list.value)) as ConnectionConfig[];
        const r = await window.api.configWrite({ connections: plain, selectedId: selectedId.value });
        if (!r.success) throw new Error(r.message || '配置写入失败');
        dirty.value = false;
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
        dirty.value = true;
        persist();
        return c;
    }

    function select(id: string): void {
        selectedId.value = id;
        persist();
    }

    function remove(id: string): void {
        const idx = list.value.findIndex((c) => c.id === id);
        if (idx < 0) return;
        list.value.splice(idx, 1);
        if (selectedId.value === id) {
            selectedId.value = list.value[0]?.id ?? null;
        }
        persist();
    }

    function duplicate(id: string): ConnectionConfig | null {
        const src = list.value.find((c) => c.id === id);
        if (!src) return null;
        const copy: ConnectionConfig = {
            ...src,
            id: randomId(),
            name: src.name + ' · 副本',
            createdAt: Date.now(),
            updatedAt: Date.now()
        };
        list.value.push(copy);
        selectedId.value = copy.id;
        persist();
        return copy;
    }

    function update(id: string, patch: Partial<ConnectionConfig>): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        Object.assign(c, patch, { updatedAt: Date.now() });
        dirty.value = true;
    }

    function addSubscription(id: string, sub: SubscriptionConfig): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        if (c.subscriptions.find((s) => s.topic === sub.topic)) return;
        c.subscriptions.push(sub);
        persist();
    }

    function removeSubscription(id: string, topic: string): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        c.subscriptions = c.subscriptions.filter((s) => s.topic !== topic);
        persist();
    }

    function setSubscriptionPaused(id: string, topic: string, paused: boolean): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        const s = c.subscriptions.find((x) => x.topic === topic);
        if (!s) return;
        s.paused = paused;
        persist();
    }

    function toggleDisableTopic(id: string, topic: string, disabled: boolean): void {
        const c = list.value.find((x) => x.id === id);
        if (!c) return;
        const set = new Set(c.disabledTopics);
        if (disabled) set.add(topic); else set.delete(topic);
        c.disabledTopics = [...set];
        persist();
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
        addSubscription,
        removeSubscription,
        setSubscriptionPaused,
        toggleDisableTopic,
        setState
    };
});
