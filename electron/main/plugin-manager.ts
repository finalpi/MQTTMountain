/**
 * 插件系统主进程核心：
 *   - 扫描 ~/plugins 目录
 *   - 加载 manifest，require runtime（只在启用时）
 *   - 按 topic 路由 decode 请求到所有启用的插件，第一个返回非 null 的即为结果
 *   - 支持从 git clone 安装、从本地目录拷贝安装、卸载
 *   - 启用状态持久化到 app_config（SQLite）
 */

import { app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import type {
    DecodedResult,
    PluginManifest,
    PluginRecord,
    PluginRuntime,
    SenderDefinition,
    PluginInstallSource,
    PluginViewDefinition,
    PluginUpdateInfo
} from '../../shared/plugin';

const PLUGIN_DIR = path.join(app.getPath('userData'), 'plugins');
const CONFIG_DB_PATH = path.join(app.getPath('userData'), 'mqtt_mountain.db');
const CONFIG_KEY = 'plugins';
const HOST_VERSION = app.getVersion();
const PLUGIN_ID_RE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,119})$/u;

interface LoadedPlugin {
    manifest: PluginManifest;
    dir: string;
    runtime?: PluginRuntime;
    enabled: boolean;
    loaded: boolean;
    error?: string;
    source?: PluginInstallSource;
    senders: SenderDefinition[];
    views: PluginViewDefinition[];
}

interface PersistedState {
    [pluginId: string]: { enabled: boolean; source?: PluginInstallSource };
}

function escapeInlineText(text: string): string {
    return text.replace(/<\/(script|style)/gi, '<\\/$1');
}

function isPathInside(parentDir: string, targetPath: string): boolean {
    const relative = path.relative(path.resolve(parentDir), path.resolve(targetPath));
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPluginId(id: string): string {
    const normalized = String(id || '').trim();
    if (!PLUGIN_ID_RE.test(normalized)) {
        throw new Error('manifest id 只能包含字母、数字、点、下划线和连字符，且长度不能超过 120');
    }
    return normalized;
}

function resolvePluginFile(pluginDir: string, relativePath: string, label: string): string {
    const requested = String(relativePath || '').trim();
    if (!requested || path.isAbsolute(requested)) throw new Error(`${label} 必须是插件目录内的相对路径`);
    const target = path.resolve(pluginDir, requested);
    if (!isPathInside(pluginDir, target)) throw new Error(`${label} 不能指向插件目录外`);
    if (!fs.existsSync(target)) return target;
    const realRoot = fs.realpathSync(pluginDir);
    const realTarget = fs.realpathSync(target);
    if (!isPathInside(realRoot, realTarget)) throw new Error(`${label} 不能通过符号链接指向插件目录外`);
    return target;
}

function managedPluginTarget(name: string): string {
    const target = path.resolve(PLUGIN_DIR, name);
    const relative = path.relative(path.resolve(PLUGIN_DIR), target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new Error('非法插件安装目录');
    }
    return target;
}

function assertManagedPluginDir(dir: string): void {
    const relative = path.relative(path.resolve(PLUGIN_DIR), path.resolve(dir));
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || relative.includes(path.sep)) {
        throw new Error('拒绝操作插件根目录之外的路径');
    }
}

function inlineViewAssets(html: string, entryPath: string, pluginDir: string): string {
    const viewDir = path.dirname(entryPath);

    const withStyles = html.replace(
        /<link\b([^>]*?)rel=["']stylesheet["']([^>]*?)href=["']([^"']+)["']([^>]*)>/gi,
        (match, before, middle, href, after) => {
            if (/^(https?:|data:|blob:|\/\/)/i.test(href)) return match;
            const localHref = String(href).split(/[?#]/u, 1)[0];
            const assetPath = resolvePluginFile(pluginDir, path.relative(pluginDir, path.resolve(viewDir, localHref)), '插件样式');
            if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return match;
            const css = fs.readFileSync(assetPath, 'utf8');
            return `<style data-plugin-inline="css"${before || ''}${middle || ''}${after || ''}>${escapeInlineText(css)}</style>`;
        }
    );

    return withStyles.replace(
        /<script\b([^>]*?)src=["']([^"']+)["']([^>]*)>\s*<\/script>/gi,
        (match, before, src, after) => {
            if (/^(https?:|data:|blob:|\/\/)/i.test(src)) {
                throw new Error('插件页面禁止加载远程脚本，请将依赖打包到插件目录');
            }
            const localSrc = String(src).split(/[?#]/u, 1)[0];
            const assetPath = resolvePluginFile(pluginDir, path.relative(pluginDir, path.resolve(viewDir, localSrc)), '插件脚本');
            if (!fs.existsSync(assetPath) || !fs.statSync(assetPath).isFile()) return match;
            const code = fs.readFileSync(assetPath, 'utf8');
            const attrs = `${before || ''}${after || ''}`.replace(/\bcrossorigin(?:=(["']).*?\1)?/gi, '');
            return `<script${attrs}>${escapeInlineText(code)}<\/script>`;
        }
    );
}

function dedupeById<T extends { id: string }>(items: T[] | undefined): T[] {
    if (!items?.length) return [];
    const map = new Map<string, T>();
    for (const item of items) {
        if (!map.has(item.id)) map.set(item.id, item);
    }
    return [...map.values()];
}

function topicMatchesPattern(topic: string, pattern: string): boolean {
    const topicParts = topic.split('/');
    const patternParts = pattern.split('/');
    for (let i = 0; i < patternParts.length; i++) {
        const part = patternParts[i];
        if (part === '#') return i === patternParts.length - 1;
        if (i >= topicParts.length) return false;
        if (part !== '+' && part !== topicParts[i]) return false;
    }
    return topicParts.length === patternParts.length;
}

function pluginAcceptsTopic(manifest: PluginManifest, topic: string): boolean {
    const patterns = manifest.topicPatterns;
    if (!patterns?.length) return true;
    return patterns.some((pattern) => topicMatchesPattern(topic, pattern));
}

class PluginManager {
    private plugins = new Map<string, LoadedPlugin>();
    private ready = false;

    /** 扫描本地目录并按持久化的 enabled 状态加载 runtime */
    async init(): Promise<void> {
        fs.mkdirSync(PLUGIN_DIR, { recursive: true });
        this.plugins.clear();
        const state = this.readState();
        const dirs = fs.readdirSync(PLUGIN_DIR, { withFileTypes: true });
        for (const d of dirs) {
            const full = path.join(PLUGIN_DIR, d.name);
            let isDirLike = false;
            try {
                isDirLike = fs.statSync(full).isDirectory();
            } catch {
                isDirLike = false;
            }
            if (!isDirLike) continue;
            try {
                const manifest = this.loadManifest(full);
                if (this.plugins.has(manifest.id)) {
                    throw new Error(`插件 id 冲突：${manifest.id}`);
                }
                const stateEntry = state[manifest.id];
                const enabled = stateEntry?.enabled ?? false;
                const source = stateEntry?.source;
                const plugin: LoadedPlugin = {
                    manifest,
                    dir: full,
                    enabled,
                    loaded: false,
                    source,
                    senders: manifest.senders ? [...manifest.senders] : [],
                    views: manifest.views ? [...manifest.views] : []
                };
                this.plugins.set(manifest.id, plugin);
                if (enabled) await this.loadRuntime(plugin);
            } catch (e) {
                console.error(`[plugin] scan ${d.name}:`, (e as Error).message);
            }
        }
        this.ready = true;
    }

    // --------------- persistence ---------------
    private openDb(): Database.Database {
        const db = new Database(CONFIG_DB_PATH);
        db.exec("CREATE TABLE IF NOT EXISTS app_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
        return db;
    }
    private readState(): PersistedState {
        try {
            const db = this.openDb();
            const row = db.prepare('SELECT value FROM app_config WHERE key = ?').get(CONFIG_KEY) as { value: string } | undefined;
            db.close();
            if (!row) return {};
            return JSON.parse(row.value) as PersistedState;
        } catch (e) {
            console.error('[plugin] readState:', e);
            return {};
        }
    }
    private writeState(): void {
        try {
            const state: PersistedState = {};
            for (const p of this.plugins.values()) {
                state[p.manifest.id] = { enabled: p.enabled, source: p.source };
            }
            const db = this.openDb();
            db.prepare('INSERT OR REPLACE INTO app_config (key, value) VALUES (?, ?)').run(CONFIG_KEY, JSON.stringify(state));
            db.close();
        } catch (e) {
            console.error('[plugin] writeState:', e);
        }
    }

    // --------------- manifest ---------------
    private loadManifest(dir: string): PluginManifest {
        const manifestPath = path.join(dir, 'mqttmountain-plugin.json');
        if (!fs.existsSync(manifestPath)) throw new Error('缺少 mqttmountain-plugin.json');
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PluginManifest;
        if (!raw.id || !raw.name || !raw.version) {
            throw new Error('manifest 缺少必要字段 id/name/version');
        }
        raw.id = assertPluginId(raw.id);
        return raw;
    }

    // --------------- runtime load/unload ---------------
    private async loadRuntime(p: LoadedPlugin): Promise<void> {
        const mainFile = resolvePluginFile(p.dir, p.manifest.main || 'index.js', '插件运行时入口');
        if (!fs.existsSync(mainFile)) {
            p.error = `入口文件不存在：${p.manifest.main || 'index.js'}`;
            p.loaded = false;
            return;
        }
        try {
            // 清理缓存以支持热重载
            this.clearRequireCache(mainFile);
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const mod = require(mainFile);
            const runtime: PluginRuntime = (mod && mod.default) ? mod.default : mod;
            p.runtime = runtime;
            // 合并动态 senders
            const dynSenders = typeof runtime.senders === 'function' ? runtime.senders() : runtime.senders;
            const dynViews = typeof runtime.views === 'function' ? runtime.views() : runtime.views;
            const base = p.manifest.senders ? [...p.manifest.senders] : [];
            const baseViews = p.manifest.views ? [...p.manifest.views] : [];
            p.senders = dedupeById([...base, ...(dynSenders || [])]);
            p.views = dedupeById([...baseViews, ...(dynViews || [])]);
            if (typeof runtime.activate === 'function') {
                await runtime.activate({
                    pluginId: p.manifest.id,
                    pluginDir: p.dir,
                    hostVersion: HOST_VERSION,
                    log: (msg: string) => console.log(`[plugin:${p.manifest.id}]`, msg)
                });
            }
            p.loaded = true;
            p.error = undefined;
            console.log(`[plugin] loaded ${p.manifest.id}@${p.manifest.version}`);
        } catch (e) {
            p.error = (e as Error).message;
            p.loaded = false;
            console.error(`[plugin] load ${p.manifest.id}:`, e);
        }
    }

    private async unloadRuntime(p: LoadedPlugin): Promise<void> {
        if (p.runtime && typeof p.runtime.deactivate === 'function') {
            try { await p.runtime.deactivate(); } catch (e) { console.error('[plugin] deactivate:', e); }
        }
        const mainFile = resolvePluginFile(p.dir, p.manifest.main || 'index.js', '插件运行时入口');
        this.clearRequireCache(mainFile);
        p.runtime = undefined;
        p.loaded = false;
        p.senders = p.manifest.senders ? [...p.manifest.senders] : [];
        p.views = p.manifest.views ? [...p.manifest.views] : [];
    }

    private clearRequireCache(entryFile: string): void {
        try {
            const resolved = require.resolve(entryFile);
            const seen = new Set<string>();
            const walk = (id: string) => {
                if (seen.has(id)) return;
                seen.add(id);
                const mod = require.cache[id];
                if (!mod) return;
                for (const child of mod.children || []) walk(child.id);
                delete require.cache[id];
            };
            walk(resolved);
        } catch {
            /* 忽略 resolve 失败（第一次加载） */
        }
    }

    // --------------- public API ---------------
    list(): PluginRecord[] {
        return [...this.plugins.values()].map((p) => ({
            manifest: p.manifest,
            dir: p.dir,
            enabled: p.enabled,
            loaded: p.loaded,
            error: p.error,
            source: p.source,
            hasDecoder: !!p.runtime?.decode,
            hasTopicLabel: !!p.runtime?.topicLabel,
            senders: p.senders,
            views: p.views
        }));
    }

    async setEnabled(pluginId: string, enabled: boolean): Promise<void> {
        const p = this.plugins.get(pluginId);
        if (!p) throw new Error('未找到插件：' + pluginId);
        if (p.enabled === enabled) return;
        p.enabled = enabled;
        if (enabled) await this.loadRuntime(p);
        else await this.unloadRuntime(p);
        this.writeState();
    }

    /** 执行 decode：遍历所有已启用且实现 decode 的插件，第一个非 null 结果获胜 */
    async decode(topic: string, payload: string): Promise<DecodedResult | null> {
        for (const p of this.plugins.values()) {
            if (!p.enabled || !p.loaded || !p.runtime?.decode) continue;
            if (!pluginAcceptsTopic(p.manifest, topic)) continue;
            try {
                const r = await p.runtime.decode(topic, payload);
                if (r) return r;
            } catch (e) {
                console.error(`[plugin:${p.manifest.id}] decode error:`, e);
            }
        }
        return null;
    }

    /** 批量 decode（性能：一次 IPC 解析一大批消息） */
    async decodeBatch(items: { topic: string; payload: string }[]): Promise<(DecodedResult | null)[]> {
        const out = new Array<DecodedResult | null>(items.length);
        for (let i = 0; i < items.length; i++) out[i] = await this.decode(items[i].topic, items[i].payload);
        return out;
    }

    /** 仅算 topicLabel（用来批量给主题列加中文标签） */
    async topicLabels(topics: string[]): Promise<Record<string, string>> {
        const map: Record<string, string> = {};
        for (const p of this.plugins.values()) {
            if (!p.enabled || !p.loaded || !p.runtime?.topicLabel) continue;
            for (const t of topics) {
                if (map[t] != null) continue;
                try {
                    const label = p.runtime.topicLabel(t);
                    if (label) map[t] = label;
                } catch (e) {
                    console.error(`[plugin:${p.manifest.id}] topicLabel error:`, e);
                }
            }
        }
        return map;
    }

    async senderParamAction(
        pluginId: string,
        request: { senderId: string; paramKey: string; actionId: string; params: Record<string, string> }
    ): Promise<string | number | boolean | Record<string, string | number | boolean>> {
        const p = this.plugins.get(pluginId);
        if (!p || !p.enabled || !p.loaded || !p.runtime?.senderParamAction) {
            throw new Error('插件未提供参数动作：' + pluginId);
        }
        return await p.runtime.senderParamAction(request);
    }

    // --------------- install / uninstall ---------------
    async installFromGit(url: string, ref?: string): Promise<PluginRecord> {
        if (!url || !url.trim()) throw new Error('Git URL 不能为空');
        const name = deriveDirName(url);
        const target = managedPluginTarget(name);
        if (fs.existsSync(target)) {
            throw new Error(`目标目录已存在：${target}，请先卸载或改名`);
        }
        fs.mkdirSync(PLUGIN_DIR, { recursive: true });
        await gitClone(url, target, ref);
        try {
            const manifest = this.loadManifest(target);
            const source: PluginInstallSource = { type: 'git', url, ref };
            const plugin: LoadedPlugin = {
                manifest,
                dir: target,
                enabled: false,
                loaded: false,
                source,
                senders: manifest.senders ? [...manifest.senders] : [],
                views: manifest.views ? [...manifest.views] : []
            };
            // 如果同 id 已存在，拒绝
            if (this.plugins.has(manifest.id)) {
                fs.rmSync(target, { recursive: true, force: true });
                throw new Error(`插件 id 冲突：${manifest.id} 已安装`);
            }
            this.plugins.set(manifest.id, plugin);
            this.writeState();
            return this.list().find((x) => x.manifest.id === manifest.id)!;
        } catch (e) {
            fs.rmSync(target, { recursive: true, force: true });
            throw e;
        }
    }

    async installFromPath(localPath: string): Promise<PluginRecord> {
        if (!localPath || !fs.existsSync(localPath)) throw new Error('本地路径不存在');
        const manifest = this.loadManifest(localPath);
        if (this.plugins.has(manifest.id)) {
            throw new Error(`插件 id 冲突：${manifest.id} 已安装`);
        }
        const target = managedPluginTarget(manifest.id);
        const resolvedLocalPath = fs.realpathSync(localPath);
        if (fs.existsSync(target)) {
            throw new Error(`目标目录已存在：${target}，请先确认并移除旧目录`);
        }
        fs.symlinkSync(
            resolvedLocalPath,
            target,
            process.platform === 'win32' ? 'junction' : 'dir'
        );
        const plugin: LoadedPlugin = {
            manifest,
            dir: target,
            enabled: false,
            loaded: false,
            source: { type: 'path', path: resolvedLocalPath },
            senders: manifest.senders ? [...manifest.senders] : [],
            views: manifest.views ? [...manifest.views] : []
        };
        this.plugins.set(manifest.id, plugin);
        this.writeState();
        return this.list().find((x) => x.manifest.id === manifest.id)!;
    }

    async uninstall(pluginId: string): Promise<void> {
        const p = this.plugins.get(pluginId);
        if (!p) throw new Error('未找到插件：' + pluginId);
        if (p.enabled) await this.unloadRuntime(p);
        assertManagedPluginDir(p.dir);
        fs.rmSync(p.dir, { recursive: true, force: true });
        this.plugins.delete(pluginId);
        this.writeState();
    }

    async reload(pluginId: string): Promise<void> {
        const p = this.plugins.get(pluginId);
        if (!p) throw new Error('未找到插件：' + pluginId);
        // 重新读 manifest
        try {
            const nextManifest = this.loadManifest(p.dir);
            if (nextManifest.id !== pluginId) {
                throw new Error(`插件更新不能修改 id：期望 ${pluginId}，实际 ${nextManifest.id}`);
            }
            const collision = this.plugins.get(nextManifest.id);
            if (collision && collision !== p) throw new Error(`插件 id 冲突：${nextManifest.id}`);
            p.manifest = nextManifest;
        } catch (e) {
            p.error = (e as Error).message;
            throw e;
        }
        p.senders = p.manifest.senders ? [...p.manifest.senders] : [];
        p.views = p.manifest.views ? [...p.manifest.views] : [];
        if (p.enabled) {
            await this.unloadRuntime(p);
            await this.loadRuntime(p);
        }
    }

    /** git pull 升级（仅 git 源） */
    async updateFromGit(pluginId: string): Promise<void> {
        const p = this.plugins.get(pluginId);
        if (!p) throw new Error('未找到插件：' + pluginId);
        if (p.source?.type !== 'git') throw new Error('该插件不是 git 安装的，无法自动升级');
        await gitPull(p.dir);
        await this.reload(pluginId);
    }

    async checkUpdates(): Promise<PluginUpdateInfo[]> {
        const out: PluginUpdateInfo[] = [];
        for (const p of this.plugins.values()) {
            if (p.source?.type !== 'git') continue;
            try {
                const info = await gitCheckUpdate(p.dir, p.source.ref);
                out.push({
                    pluginId: p.manifest.id,
                    pluginName: p.manifest.name,
                    ...info
                });
            } catch (e) {
                out.push({
                    pluginId: p.manifest.id,
                    pluginName: p.manifest.name,
                    currentRevision: '',
                    latestRevision: '',
                    hasUpdate: false,
                    message: (e as Error).message
                });
            }
        }
        return out;
    }

    readViewHtml(pluginId: string, viewId: string): { html: string; baseUrl: string } {
        const p = this.plugins.get(pluginId);
        if (!p) throw new Error('未找到插件：' + pluginId);
        const view = p.views.find((item) => item.id === viewId);
        if (!view) throw new Error('未找到视图：' + viewId);
        if (view.type !== 'web') throw new Error('该视图不是插件自定义页面');
        const entryPath = resolvePluginFile(p.dir, view.entry, '插件页面入口');
        if (!fs.existsSync(entryPath)) throw new Error('插件页面入口不存在：' + view.entry);
        const html = inlineViewAssets(fs.readFileSync(entryPath, 'utf8'), entryPath, p.dir);
        const baseDir = path.dirname(entryPath);
        const normalizedBase = baseDir.endsWith(path.sep) ? baseDir : `${baseDir}${path.sep}`;
        return {
            html,
            baseUrl: pathToFileURL(normalizedBase).toString()
        };
    }

    shutdown(): void {
        for (const p of this.plugins.values()) {
            if (p.enabled && p.runtime?.deactivate) {
                try { p.runtime.deactivate(); } catch {}
            }
        }
    }

    get isReady(): boolean { return this.ready; }
    get pluginsDir(): string { return PLUGIN_DIR; }
}

// --------------- helpers ---------------
function deriveDirName(url: string): string {
    const base = url.split('/').pop() || '';
    return base.replace(/\.git$/, '') || `plugin-${Date.now()}`;
}

function gitClone(url: string, target: string, ref?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const args = ['clone', '--depth', '1'];
        if (ref) args.push('--branch', ref);
        args.push(url, target);
        execFile('git', args, { windowsHide: true, timeout: 120_000 }, (err, _stdout, stderr) => {
            if (err) {
                reject(new Error(`git clone 失败：${stderr || err.message}`));
            } else {
                resolve();
            }
        });
    });
}

function gitPull(dir: string): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', dir, 'pull', '--ff-only'], { windowsHide: true, timeout: 120_000 }, (err, _stdout, stderr) => {
            if (err) reject(new Error(`git pull 失败：${stderr || err.message}`));
            else resolve();
        });
    });
}

function gitOutput(dir: string, args: string[], timeout = 60_000): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile('git', ['-C', dir, ...args], { windowsHide: true, timeout }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(String(stdout).trim());
        });
    });
}

async function remoteDefaultBranch(dir: string): Promise<string> {
    const output = await gitOutput(dir, ['ls-remote', '--symref', 'origin', 'HEAD']);
    const match = output.match(/ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
    if (!match) throw new Error('无法识别远端默认分支');
    return match[1];
}

async function remoteRevision(dir: string, ref?: string): Promise<{ branch?: string; revision: string }> {
    const currentBranch = await gitOutput(dir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const branch = currentBranch && currentBranch !== 'HEAD'
        ? currentBranch
        : (ref && !/^v?\d+\.\d+\.\d+/.test(ref) ? ref : await remoteDefaultBranch(dir));
    const output = await gitOutput(dir, ['ls-remote', 'origin', `refs/heads/${branch}`]);
    const revision = output.split(/\s+/)[0];
    if (!revision) throw new Error(`远端分支不存在：${branch}`);
    return { branch, revision };
}

async function gitCheckUpdate(dir: string, ref?: string): Promise<Omit<PluginUpdateInfo, 'pluginId' | 'pluginName'>> {
    const currentRevision = await gitOutput(dir, ['rev-parse', 'HEAD']);
    const remote = await remoteRevision(dir, ref);
    return {
        currentRevision,
        latestRevision: remote.revision,
        hasUpdate: currentRevision !== remote.revision,
        branch: remote.branch
    };
}

export const pluginManager = new PluginManager();
