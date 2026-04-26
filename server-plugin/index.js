'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Plugin metadata
const info = {
    id: 'anamnesis',
    name: 'Anamnesis Memory Bridge',
    description: 'Bridges SillyTavern to the Anamnesis 5.0 MCP memory server (Synapse Neural DB)',
};

// ============================================================================
// MCP CLIENT — speaks JSON-RPC over stdio to the Anamnesis MCP server
// ============================================================================

class McpClient {
    constructor() {
        this.process = null;
        this.requestId = 0;
        this.pending = new Map();
        this.buffer = '';
        this.ready = false;
    }

    /**
     * Spawn the Anamnesis MCP server process.
     * @param {string} command - Python executable
     * @param {string[]} args - Arguments (path to anamnesis_5_mcp_server.py)
     */
    async start(command, args) {
        if (this.process) return;

        this.process = spawn(command, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env },
        });

        this.process.stdout.on('data', (chunk) => this._onData(chunk));
        this.process.stderr.on('data', (chunk) => {
            console.error(`[anamnesis] stderr: ${chunk.toString().trim()}`);
        });
        this.process.on('close', (code) => {
            console.log(`[anamnesis] MCP server exited with code ${code}`);
            this.process = null;
            this.ready = false;
        });

        // Send MCP initialize handshake
        const initResult = await this.call('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'sillytavern-anamnesis', version: '1.0.0' },
        });
        console.log('[anamnesis] MCP initialized:', JSON.stringify(initResult).slice(0, 200));

        // Send initialized notification
        this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        this.ready = true;
    }

    /** Call an MCP tool by name */
    async callTool(toolName, args) {
        return this.call('tools/call', { name: toolName, arguments: args });
    }

    /** Low-level JSON-RPC call */
    call(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const msg = { jsonrpc: '2.0', id, method, params };
            this.pending.set(id, { resolve, reject });
            this._send(msg);

            // Timeout after 30s
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP call ${method} timed out`));
                }
            }, 30000);
        });
    }

    _send(msg) {
        if (!this.process?.stdin?.writable) {
            throw new Error('MCP server not running');
        }
        const json = JSON.stringify(msg);
        this.process.stdin.write(json + '\n');
    }

    _onData(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop(); // keep incomplete line

        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) {
                        reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    } else {
                        resolve(msg.result);
                    }
                }
            } catch (e) {
                // Not JSON — ignore (could be log output)
            }
        }
    }

    stop() {
        if (this.process) {
            this.process.kill();
            this.process = null;
            this.ready = false;
        }
    }
}

// ============================================================================
// STANDALONE FALLBACK — if no MCP server is configured, use a local JSON store
// ============================================================================

class LocalMemoryStore {
    constructor(dataDir) {
        this.dataDir = dataDir;
        this.dbPath = path.join(dataDir, 'memories.json');
        fs.mkdirSync(dataDir, { recursive: true });
        this.memories = this._load();
    }

    _load() {
        if (fs.existsSync(this.dbPath)) {
            return JSON.parse(fs.readFileSync(this.dbPath, 'utf-8'));
        }
        return { memories: [], indexes: {}, nextId: 1 };
    }

    _save() {
        fs.writeFileSync(this.dbPath, JSON.stringify(this.memories, null, 2));
    }

    remember(content, category, associations, tags, importance, emotionalIntensity, summary) {
        const id = `mem_${this.memories.nextId++}`;
        const entry = {
            id,
            content,
            category: category || 'general',
            associations: associations || [],
            tags: tags || ['general'],
            importance: importance || 5,
            emotional_intensity: emotionalIntensity || 0.5,
            summary: summary || content.slice(0, 100),
            created_at: new Date().toISOString(),
        };
        this.memories.memories.push(entry);
        this._save();
        return { memory_id: id, index_created: true, category: entry.category, associations: entry.associations };
    }

    recall(prompt, limit = 5) {
        const promptLower = prompt.toLowerCase();
        const scored = this.memories.memories.map(m => {
            let keywordHits = 0;
            const text = `${m.content} ${m.summary} ${(m.tags || []).join(' ')} ${(m.associations || []).join(' ')}`.toLowerCase();
            const words = promptLower.split(/\s+/);
            for (const w of words) {
                if (w.length > 2 && text.includes(w)) keywordHits += 1;
            }
            // Require at least one keyword match, then boost by importance/emotion
            if (keywordHits === 0) return { ...m, score: 0 };
            const score = keywordHits + (m.importance || 5) * 0.1 + (m.emotional_intensity || 0.5) * 0.5;
            return { ...m, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).filter(m => m.score > 0);
    }

    getStats() {
        const cats = {};
        for (const m of this.memories.memories) {
            cats[m.category] = (cats[m.category] || 0) + 1;
        }
        return { total_memories: this.memories.memories.length, categories: cats };
    }

    listCategories() {
        const cats = {};
        for (const m of this.memories.memories) {
            cats[m.category] = (cats[m.category] || 0) + 1;
        }
        return cats;
    }
}

// ============================================================================
// PLUGIN INIT
// ============================================================================

/** @type {McpClient | null} */
let mcpClient = null;
/** @type {LocalMemoryStore | null} */
let localStore = null;

const CONFIG_PATH = path.join(os.homedir(), '.anamnesis5', 'sillytavern-config.json');

function loadConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    return { mode: 'local', python: 'python3', serverScript: '', entityName: 'SillyTavern' };
}

function saveConfig(config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

/**
 * Extract text content from an MCP tool call result.
 */
function extractMcpText(result) {
    if (!result) return null;
    const content = result.content || [];
    for (const c of content) {
        if (c.type === 'text') {
            try { return JSON.parse(c.text); } catch { return c.text; }
        }
    }
    return result;
}

async function init(router) {
    console.log('[anamnesis] Initializing Anamnesis Memory Bridge plugin');

    const config = loadConfig();

    // Initialize local store as fallback (always available)
    const dataDir = path.join(os.homedir(), '.anamnesis5', config.entityName?.toLowerCase() || 'sillytavern');
    localStore = new LocalMemoryStore(dataDir);

    // Try to start MCP server if configured
    if (config.mode === 'mcp' && config.serverScript) {
        try {
            mcpClient = new McpClient();
            await mcpClient.start(config.python || 'python3', [config.serverScript]);
            console.log('[anamnesis] Connected to Anamnesis MCP server');
        } catch (err) {
            console.error('[anamnesis] Failed to start MCP server, falling back to local store:', err.message);
            mcpClient = null;
        }
    } else {
        console.log('[anamnesis] Running in local mode (no MCP server configured)');
    }

    // ------------------------------------------------------------------
    // API ROUTES
    // ------------------------------------------------------------------

    /** GET /api/plugins/anamnesis/status */
    router.get('/status', (req, res) => {
        res.json({
            mode: mcpClient?.ready ? 'mcp' : 'local',
            mcpConnected: mcpClient?.ready || false,
            localMemories: localStore?.memories?.memories?.length || 0,
        });
    });

    /** GET /api/plugins/anamnesis/config */
    router.get('/config', (req, res) => {
        res.json(loadConfig());
    });

    /** POST /api/plugins/anamnesis/config */
    router.post('/config', async (req, res) => {
        try {
            const newConfig = req.body;
            saveConfig(newConfig);

            // Restart MCP if mode changed
            if (newConfig.mode === 'mcp' && newConfig.serverScript) {
                if (mcpClient) mcpClient.stop();
                mcpClient = new McpClient();
                await mcpClient.start(newConfig.python || 'python3', [newConfig.serverScript]);
            } else {
                if (mcpClient) mcpClient.stop();
                mcpClient = null;
            }

            res.json({ success: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** POST /api/plugins/anamnesis/remember */
    router.post('/remember', async (req, res) => {
        try {
            const { content, category, associations, tags, importance, emotional_intensity, summary } = req.body;

            // Always store in local as fallback index
            localStore.remember(content, category, associations, tags, importance, emotional_intensity, summary);

            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('remember', {
                    content,
                    category: category || 'conversation',
                    associations: associations || [],
                    tags: tags || [],
                    importance: importance || 5,
                    emotional_intensity: emotional_intensity || 0.5,
                    summary,
                });
                res.json(extractMcpText(result));
            } else {
                res.json({ memory_id: 'local', index_created: true, category: category || 'general' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** POST /api/plugins/anamnesis/recall */
    router.post('/recall', async (req, res) => {
        try {
            const { prompt, limit, emotion_weight, time_filter } = req.body;

            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('what_comes_to_mind', {
                    prompt,
                    limit: limit || 5,
                    emotion_weight: emotion_weight || 0.3,
                    time_filter,
                });
                const parsed = extractMcpText(result);

                // If Synapse needs an index rebuild, fall back to local store
                if (parsed?.error && parsed.error.includes('index not built')) {
                    console.log('[anamnesis] Synapse vector index not yet built, falling back to local store');
                    const memories = localStore.recall(prompt, limit || 5);
                    res.json({ success: true, count: memories.length, memories, note: 'local_fallback' });
                } else {
                    res.json(parsed);
                }
            } else {
                const memories = localStore.recall(prompt, limit || 5);
                res.json({ success: true, count: memories.length, memories });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** GET /api/plugins/anamnesis/categories */
    router.get('/categories', async (req, res) => {
        try {
            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('list_categories', {});
                res.json(extractMcpText(result));
            } else {
                res.json({ success: true, categories: localStore.listCategories() });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** GET /api/plugins/anamnesis/stats */
    router.get('/stats', async (req, res) => {
        try {
            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('get_graph_stats', {});
                res.json(extractMcpText(result));
            } else {
                res.json({ success: true, stats: localStore.getStats() });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** GET /api/plugins/anamnesis/bootstrap */
    router.get('/bootstrap', async (req, res) => {
        try {
            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('load_bootstrap', {});
                res.json(extractMcpText(result));
            } else {
                res.json({ success: false, message: 'Bootstrap requires MCP server' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** POST /api/plugins/anamnesis/index-search */
    router.post('/index-search', async (req, res) => {
        try {
            const { category, associations, tags, min_importance, limit } = req.body;

            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('index_search', {
                    category,
                    associations,
                    tags,
                    min_importance: min_importance || 0,
                    limit: limit || 50,
                });
                res.json(extractMcpText(result));
            } else {
                // Basic filter for local store
                let results = localStore.memories.memories;
                if (category) results = results.filter(m => m.category === category);
                if (min_importance) results = results.filter(m => m.importance >= min_importance);
                res.json({ success: true, count: results.length, results: results.slice(0, limit || 50) });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    console.log('[anamnesis] Plugin routes registered under /api/plugins/anamnesis/');
}

function exit() {
    if (mcpClient) {
        mcpClient.stop();
        mcpClient = null;
    }
    console.log('[anamnesis] Plugin shut down');
}

module.exports = { info, init, exit };
