import { reactive } from 'vue';
import type { ConnectionConfig, SubscriptionConfig } from '@shared/types';
import { pickOutermost } from '@/utils/mqttFilter';

/**
 * 本地订阅列表与 broker 实际订阅解耦。
 * - 本地列表 (c.subscriptions) 完全反映用户配置，永不因覆盖关系增删
 * - broker 端只订阅"互不覆盖的最外层 filter"，避免重复投递
 * - 每次本地列表 / 暂停状态 / 连接状态变化后调用 sync()，与 broker 做差异化同步
 */

/** key 是 connectionId；value 是当前已向 broker 发送了 SUBSCRIBE 的 topic→qos 映射 */
const brokerSubs = reactive<Record<string, Record<string, 0 | 1 | 2>>>({});
const syncChains = new Map<string, Promise<SyncResult>>();
const syncGenerations = new Map<string, number>();

export interface SyncResult {
    ok: boolean;
    errors: string[];
}

function effectiveFor(c: ConnectionConfig): SubscriptionConfig[] {
    const active = c.subscriptions.filter((s) => !s.paused);
    return pickOutermost(active);
}

async function runSync(c: ConnectionConfig, connected: boolean, generation: number): Promise<SyncResult> {
    const id = c.id;
    if (!connected) return { ok: true, errors: [] }; // 未连接时只保存本地期望状态
    const desired = effectiveFor(c);
    const desiredMap: Record<string, 0 | 1 | 2> = {};
    for (const s of desired) desiredMap[s.topic] = s.qos;
    const current = brokerSubs[id] ?? {};
    const errors: string[] = [];

    // 1) 取消不再需要的
    for (const t of Object.keys(current)) {
        if (!(t in desiredMap)) {
            const result = await window.api.mqttUnsubscribe({ connectionId: id, topic: t });
            if (syncGenerations.get(id) !== generation) return { ok: false, errors: ['连接状态已变化'] };
            if (result.success) delete current[t];
            else errors.push(`取消订阅 ${t} 失败：${result.message || '未知错误'}`);
        }
    }
    // 2) 新增需要的（或 qos 变化时重新订阅）
    for (const t of Object.keys(desiredMap)) {
        const newQos = desiredMap[t];
        if (current[t] !== newQos) {
            if (current[t] !== undefined) {
                const removed = await window.api.mqttUnsubscribe({ connectionId: id, topic: t });
                if (syncGenerations.get(id) !== generation) return { ok: false, errors: ['连接状态已变化'] };
                if (!removed.success) {
                    errors.push(`更新订阅 ${t} 失败：${removed.message || '取消旧 QoS 失败'}`);
                    continue;
                }
                delete current[t];
            }
            const r = await window.api.mqttSubscribe({ connectionId: id, topic: t, qos: newQos });
            if (syncGenerations.get(id) !== generation) return { ok: false, errors: ['连接状态已变化'] };
            if (r.success) current[t] = newQos;
            else errors.push(`订阅 ${t} 失败：${r.message || '未知错误'}`);
        }
    }
    brokerSubs[id] = current;
    return { ok: errors.length === 0, errors };
}

async function sync(c: ConnectionConfig, connected: boolean): Promise<SyncResult> {
    const id = c.id;
    const generation = syncGenerations.get(id) ?? 0;
    const previous = syncChains.get(id) ?? Promise.resolve({ ok: true, errors: [] });
    const next = previous
        .catch(() => ({ ok: false, errors: ['上一次订阅同步异常'] }))
        .then(() => runSync(c, connected, generation));
    syncChains.set(id, next);
    try {
        return await next;
    } catch (error) {
        return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    } finally {
        if (syncChains.get(id) === next) syncChains.delete(id);
    }
}

function reset(connectionId: string): void {
    syncGenerations.set(connectionId, (syncGenerations.get(connectionId) ?? 0) + 1);
    syncChains.delete(connectionId);
    delete brokerSubs[connectionId];
}

export function useSubscriptionSync() {
    return { sync, reset, brokerSubs };
}
