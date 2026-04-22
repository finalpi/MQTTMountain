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

function effectiveFor(c: ConnectionConfig): SubscriptionConfig[] {
    const active = c.subscriptions.filter((s) => !s.paused);
    return pickOutermost(active);
}

async function sync(c: ConnectionConfig, connected: boolean): Promise<void> {
    const id = c.id;
    if (!connected) return; // 未连接时不做 broker 侧操作
    const desired = effectiveFor(c);
    const desiredMap: Record<string, 0 | 1 | 2> = {};
    for (const s of desired) desiredMap[s.topic] = s.qos;
    const current = brokerSubs[id] ?? {};

    // 1) 取消不再需要的
    for (const t of Object.keys(current)) {
        if (!(t in desiredMap)) {
            await window.api.mqttUnsubscribe({ connectionId: id, topic: t });
            delete current[t];
        }
    }
    // 2) 新增需要的（或 qos 变化时重新订阅）
    for (const t of Object.keys(desiredMap)) {
        const newQos = desiredMap[t];
        if (current[t] !== newQos) {
            if (current[t] !== undefined) {
                await window.api.mqttUnsubscribe({ connectionId: id, topic: t });
            }
            const r = await window.api.mqttSubscribe({ connectionId: id, topic: t, qos: newQos });
            if (r.success) current[t] = newQos;
        }
    }
    brokerSubs[id] = current;
}

function reset(connectionId: string): void {
    delete brokerSubs[connectionId];
}

export function useSubscriptionSync() {
    return { sync, reset, brokerSubs };
}
