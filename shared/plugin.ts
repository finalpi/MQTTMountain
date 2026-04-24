/**
 * 插件系统共享类型。主进程 / 渲染进程 / 插件作者都依据这里的接口。
 * 插件只读（不引入任何运行时依赖），便于插件作者复制一份到自己的项目。
 */

/** 每个插件根目录的 mqttmountain-plugin.json */
export interface PluginManifest {
    /** 反向域名唯一标识，如 `com.dji.drone-mqtt` */
    id: string;
    /** 显示名 */
    name: string;
    version: string;
    description?: string;
    author?: string;
    homepage?: string;
    /** 相对 manifest 的图标路径（png/svg） */
    icon?: string;
    /** CommonJS 入口（相对 manifest），默认 `index.js` */
    main?: string;
    /** 宿主版本约束，如 { mqttmountain: ">=1.0.0" } */
    engines?: { mqttmountain?: string };
    /** 声明本插件关心的主题通配（仅用于 UI 提示、不做强制） */
    topicPatterns?: string[];
    /** 声明式 sender 列表（无需 runtime.js 也能使用） */
    senders?: SenderDefinition[];
    /** 插件可在宿主中注册独立页面视图 */
    views?: PluginViewDefinition[];
}

export interface PluginBuiltinViewDefinition {
    id: string;
    name: string;
    description?: string;
    placement: 'center';
    /**
     * 宿主内置的视图渲染器类型。
     * 后续如果需要更通用的插件页面，可以继续扩展新 type。
    */
    type: 'cloud-mqtt';
}

export interface PluginWebViewDefinition {
    id: string;
    name: string;
    description?: string;
    placement: 'center';
    type: 'web';
    entry: string;
}

export type PluginViewDefinition = PluginBuiltinViewDefinition | PluginWebViewDefinition;

/** 插件发送模板的一个参数 */
export interface SenderParam {
    key: string;
    label: string;
    /** 默认 'string' */
    type?: 'string' | 'number' | 'boolean' | 'select';
    options?: string[];
    default?: string | number | boolean;
    placeholder?: string;
    required?: boolean;
}

/** 预定义发送模板。topic / payloadTemplate 支持 `{paramKey}` 占位符 */
export interface SenderDefinition {
    id: string;
    name: string;
    description?: string;
    topic: string;
    payloadTemplate: string;
    qos?: 0 | 1 | 2;
    retain?: boolean;
    params?: SenderParam[];
    /** 分组标签，便于下拉菜单归类 */
    group?: string;
}

/** decode 返回值：宿主会把它渲染到消息卡片 / 格式化 modal */
export interface DecodedResult {
    /** 一行摘要（消息卡片上） */
    summary?: string;
    /** 关键字段高亮列表 */
    highlights?: { label: string; value: string }[];
    /** 解析后的结构化数据（宿主可能以 JSON 树形式展示） */
    tree?: unknown;
    /** 中文主题别名；宿主在主题列表中显示在原 topic 旁 */
    topicLabel?: string;
    /**
     * 从消息里提取出应加入「参数记忆」的值。
     * key 对应 sender 参数的 key（如 `sn`、`gateway`、`deviceId`）。
     * 宿主收到消息时会自动写入，后续发送时参数下拉就有这些值。
     * 例：{ sn: "8UUXNCJ00A0XWG", gateway: "8UUXNCJ00A0XWG" }
     */
    rememberParams?: Record<string, string>;
    /**
     * 宿主可消费的业务元信息。
     * 这部分应尽量保持“插件负责识别，宿主负责展示”。
     */
    meta?: PluginDecodedMeta;
    /** 自定义内容：可选字段，将用于未来扩展 */
}

export interface PluginDecodedMeta {
    family?: string;
    airportSn?: string;
    droneSn?: string;
    gatewaySn?: string;
    deviceSn?: string;
    topicKind?: string;
    messageKind?: 'telemetry' | 'event' | 'request' | 'reply' | 'status';
    direction?: 'up' | 'down';
    method?: string;
    tid?: string;
    bid?: string;
    isReply?: boolean;
    [key: string]: unknown;
}

/**
 * 插件 runtime 入口 module.exports 的形状。
 * 所有字段都可选——只需声明式 senders 的插件完全不用写 runtime。
 */
export interface PluginRuntime {
    /** 动态补充或覆盖 manifest 里的 senders，运行时计算 */
    senders?: SenderDefinition[] | (() => SenderDefinition[]);
    views?: PluginViewDefinition[] | (() => PluginViewDefinition[]);

    /**
     * 解析某条消息。返回 null 表示本插件不处理该消息（交给下一个插件 / 宿主默认）。
     * 同步或异步都可以。尽量纯函数，不要修改入参。
     */
    decode?: (topic: string, payload: string) => DecodedResult | null | Promise<DecodedResult | null>;

    /**
     * 仅返回 topic 的别名标签；比 decode 更轻量。
     * 当宿主需要批量给主题列打标签时优先调用它。
     */
    topicLabel?: (topic: string) => string | null;

    /** 激活时调用（用户启用插件后、第一次使用前触发一次） */
    activate?: (ctx: PluginContext) => void | Promise<void>;
    /** 禁用或卸载时调用 */
    deactivate?: () => void | Promise<void>;
}

/** 插件运行时获取的上下文。故意保持很小，避免插件滥用宿主能力 */
export interface PluginContext {
    pluginId: string;
    pluginDir: string;
    hostVersion: string;
    log: (msg: string) => void;
}

// ---------------------------------------------------------------------------
// 渲染端 <-> 主进程 传输的插件实例视图（不包含可执行函数）
// ---------------------------------------------------------------------------

export interface PluginInstallSource {
    type: 'git' | 'path';
    url?: string;      // git 仓库地址
    ref?: string;      // git 分支 / tag / commit
    path?: string;     // 本地源路径
}

export interface PluginRecord {
    manifest: PluginManifest;
    /** 绝对路径（渲染端仅用于显示） */
    dir: string;
    enabled: boolean;
    /** 运行时已 require 并激活 */
    loaded: boolean;
    error?: string;
    source?: PluginInstallSource;
    /** 方便 UI 显示：若有 runtime.decode 则为 true */
    hasDecoder: boolean;
    hasTopicLabel: boolean;
    /** 实际可用的 senders（manifest + runtime 合并） */
    senders: SenderDefinition[];
    views: PluginViewDefinition[];
}
