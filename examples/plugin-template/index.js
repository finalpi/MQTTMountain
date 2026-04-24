/**
 * 示例插件 runtime：演示 decode / topicLabel / 动态 sender
 *
 * MQTTMountain 在启用时会 require 本文件，以 CommonJS 格式导出。
 */

module.exports = {
    /** 激活钩子（用户首次启用 / 重载时调用） */
    activate(ctx) {
        ctx.log(`activated, pluginDir=${ctx.pluginDir}, host=${ctx.hostVersion}`);
    },

    /**
     * 解析消息。返回 null 表示「本插件不处理」。
     * topic 示例：demo/device-001/events
     */
    decode(topic, payload) {
        if (!/^demo\//.test(topic)) return null;

        let obj = null;
        try { obj = JSON.parse(payload); } catch { return null; }

        const seg = topic.split('/');
        const deviceId = seg[1] || '?';
        const kind = seg[2] || '?';

        const summary = `[${kind}] ${deviceId} · ${obj?.method || obj?.event || 'raw'}`;

        const highlights = [];
        if (deviceId !== '?') highlights.push({ label: 'device', value: deviceId });
        if (obj?.method) highlights.push({ label: 'method', value: String(obj.method) });
        if (obj?.event) highlights.push({ label: 'event', value: String(obj.event) });
        if (obj?.timestamp) {
            highlights.push({
                label: 'ts',
                value: new Date(Number(obj.timestamp)).toISOString()
            });
        }

        return { summary, highlights, tree: obj };
    },

    /**
     * 主题别名。返回 null 表示不处理。
     */
    topicLabel(topic) {
        if (!/^demo\//.test(topic)) return null;
        if (topic.endsWith('/events')) return '事件上报';
        if (topic.endsWith('/state')) return '状态同步';
        if (topic.endsWith('/services')) return '下行指令';
        return null;
    },

    /**
     * 动态 sender（与 manifest.senders 合并）。可以是数组或函数。
     */
    senders: () => [
        {
            id: 'demo.timestamp',
            name: '🕒 发送当前时间戳',
            group: '调试',
            topic: 'demo/{deviceId}/events',
            // payloadTemplate 里的 {now} 会被 MQTTMountain 用参数值替换
            payloadTemplate: '{"event":"heartbeat","timestamp":{now}}',
            qos: 0,
            params: [
                { key: 'deviceId', label: '设备 ID', required: true },
                { key: 'now', label: '时间戳（毫秒）', type: 'number', default: Date.now() }
            ]
        }
    ]
};
