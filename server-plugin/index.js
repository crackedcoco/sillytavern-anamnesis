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
// TRIBE v2 EMOTIONAL DIMENSIONS (51)
// From crackedcoco/tribe-demo — NeuroLens neural response prediction
// ============================================================================

const TRIBE_DIMENSIONS = [
    // Core Ekman (6)
    'fear', 'happiness', 'sadness', 'anger', 'disgust', 'surprise',
    // Cognitive/Engagement (7)
    'engagement', 'memory', 'mind_wandering', 'place_recognition',
    'face_processing', 'motor_resonance', 'language',
    // Social/Affiliative (7)
    'empathy', 'love', 'trust', 'belonging', 'theory_of_mind',
    'parasocial_bonding', 'social_proof',
    // Reward & Motivation (7)
    'curiosity', 'wanting', 'liking', 'amusement', 'purchase_intent',
    'anticipation_reward', 'craving',
    // Moral Foundations (7)
    'moral_outrage', 'moral_care', 'moral_fairness', 'moral_loyalty',
    'moral_authority', 'moral_sanctity', 'moral_liberty',
    // Negative/Threat (8)
    'stress', 'anxiety', 'threat_detection', 'confusion', 'boredom',
    'price_pain', 'physical_pain', 'health_anxiety',
    // Suspense/Narrative (5)
    'suspense', 'relief', 'narrative_transport', 'catharsis', 'narrative_resolution',
    // Aesthetic/Conscious (6)
    'awe', 'nostalgia', 'aesthetic_appreciation', 'authenticity_perception',
    'uncanny_valley', 'shock_startle',
    // Fundamental (2)
    'arousal', 'valence',
];

const EMOTION_SCORING_PROMPT = `Score the emotional content of this text across the following dimensions. Return ONLY a JSON object with dimension names as keys and integer scores 0-100 as values. 0 means the dimension is completely absent, 100 means it dominates the text. Most dimensions should be 0 or very low — only score dimensions that are genuinely present.

Dimensions: ${TRIBE_DIMENSIONS.join(', ')}

Text to score:
"""
{{TEXT}}
"""

Respond with ONLY the JSON object, no explanation.`;

// ============================================================================
// EMOTION SCORER — calls Claude API to score text
// ============================================================================

class EmotionScorer {
    constructor(dataRoot) {
        this.dataRoot = dataRoot;
        this._apiKey = null;
    }

    _getApiKey() {
        if (this._apiKey) return this._apiKey;
        try {
            const secretsPath = path.join(this.dataRoot, 'secrets.json');
            if (!fs.existsSync(secretsPath)) return null;
            const secrets = JSON.parse(fs.readFileSync(secretsPath, 'utf-8'));
            const claudeKeys = secrets.api_key_claude;
            if (Array.isArray(claudeKeys) && claudeKeys.length > 0) {
                const active = claudeKeys.find(k => k.active) || claudeKeys[0];
                this._apiKey = active.value;
                return this._apiKey;
            }
            if (typeof claudeKeys === 'string') {
                this._apiKey = claudeKeys;
                return this._apiKey;
            }
        } catch (e) {
            console.error('[anamnesis] Failed to read API key:', e.message);
        }
        return null;
    }

    async scoreEmotions(text) {
        const apiKey = this._getApiKey();
        if (!apiKey) {
            console.log('[anamnesis] No Claude API key available, skipping emotion scoring');
            return null;
        }

        const prompt = EMOTION_SCORING_PROMPT.replace('{{TEXT}}', text.slice(0, 2000));

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 1024,
                    messages: [{ role: 'user', content: prompt }],
                }),
            });

            if (!response.ok) {
                console.error(`[anamnesis] Emotion scoring API error: ${response.status}`);
                return null;
            }

            const data = await response.json();
            const text_response = data.content?.[0]?.text || '';

            // Extract JSON from response
            const jsonMatch = text_response.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return null;

            const scores = JSON.parse(jsonMatch[0]);

            // Validate and normalize: ensure all values are 0-100 integers
            const result = {};
            for (const dim of TRIBE_DIMENSIONS) {
                const val = scores[dim];
                if (typeof val === 'number') {
                    result[dim] = Math.max(0, Math.min(100, Math.round(val)));
                } else {
                    result[dim] = 0;
                }
            }

            // Compute composite emotional_intensity from key dimensions
            const emotionalIntensity = Math.min(1.0,
                (result.fear + result.happiness + result.sadness + result.anger +
                 result.disgust + result.surprise + result.love + result.empathy +
                 result.awe + result.stress) / 500
            );

            return {
                emotional_vector: result,
                emotional_intensity: Math.round(emotionalIntensity * 100) / 100,
                dominant_emotions: Object.entries(result)
                    .filter(([, v]) => v >= 30)
                    .sort(([, a], [, b]) => b - a)
                    .slice(0, 5)
                    .map(([k, v]) => ({ dimension: k, score: v })),
            };
        } catch (e) {
            console.error('[anamnesis] Emotion scoring failed:', e.message);
            return null;
        }
    }
}

/**
 * Compute cosine similarity between two emotional vectors.
 */
function emotionalCosineSimilarity(vecA, vecB) {
    if (!vecA || !vecB) return 0;
    let dotProduct = 0, normA = 0, normB = 0;
    for (const dim of TRIBE_DIMENSIONS) {
        const a = vecA[dim] || 0;
        const b = vecB[dim] || 0;
        dotProduct += a * b;
        normA += a * a;
        normB += b * b;
    }
    if (normA === 0 || normB === 0) return 0;
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

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

        const initResult = await this.call('initialize', {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'sillytavern-anamnesis', version: '1.0.0' },
        });
        console.log('[anamnesis] MCP initialized:', JSON.stringify(initResult).slice(0, 200));

        this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        this.ready = true;
    }

    async callTool(toolName, args) {
        return this.call('tools/call', { name: toolName, arguments: args });
    }

    call(method, params) {
        return new Promise((resolve, reject) => {
            const id = ++this.requestId;
            const msg = { jsonrpc: '2.0', id, method, params };
            this.pending.set(id, { resolve, reject });
            this._send(msg);
            setTimeout(() => {
                if (this.pending.has(id)) {
                    this.pending.delete(id);
                    reject(new Error(`MCP call ${method} timed out`));
                }
            }, 30000);
        });
    }

    _send(msg) {
        if (!this.process?.stdin?.writable) throw new Error('MCP server not running');
        this.process.stdin.write(JSON.stringify(msg) + '\n');
    }

    _onData(chunk) {
        this.buffer += chunk.toString();
        const lines = this.buffer.split('\n');
        this.buffer = lines.pop();
        for (const line of lines) {
            if (!line.trim()) continue;
            try {
                const msg = JSON.parse(line);
                if (msg.id && this.pending.has(msg.id)) {
                    const { resolve, reject } = this.pending.get(msg.id);
                    this.pending.delete(msg.id);
                    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
                    else resolve(msg.result);
                }
            } catch (e) { /* not JSON */ }
        }
    }

    stop() {
        if (this.process) { this.process.kill(); this.process = null; this.ready = false; }
    }
}

// ============================================================================
// LOCAL MEMORY STORE — with TRIBE emotional vectors
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

    remember(content, category, associations, tags, importance, emotionalIntensity, summary, emotionData) {
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
        if (emotionData) {
            entry.emotional_vector = emotionData.emotional_vector;
            entry.dominant_emotions = emotionData.dominant_emotions;
            entry.emotional_intensity = emotionData.emotional_intensity;
        }
        this.memories.memories.push(entry);
        this._save();
        return { memory_id: id, index_created: true, category: entry.category, associations: entry.associations };
    }

    recall(prompt, limit = 5, queryEmotionVector = null) {
        const promptLower = prompt.toLowerCase();
        const scored = this.memories.memories.map(m => {
            let keywordHits = 0;
            const text = `${m.content} ${m.summary} ${(m.tags || []).join(' ')} ${(m.associations || []).join(' ')}`.toLowerCase();
            const words = promptLower.split(/\s+/);
            for (const w of words) {
                if (w.length > 2 && text.includes(w)) keywordHits += 1;
            }
            if (keywordHits === 0 && !queryEmotionVector) return { ...m, score: 0 };

            let score = keywordHits + (m.importance || 5) * 0.1 + (m.emotional_intensity || 0.5) * 0.5;

            // Boost by emotional vector similarity if available
            if (queryEmotionVector && m.emotional_vector) {
                const emotionSim = emotionalCosineSimilarity(queryEmotionVector, m.emotional_vector);
                score += emotionSim * 3; // Weighted emotional match
            }

            return { ...m, score };
        });
        scored.sort((a, b) => b.score - a.score);
        return scored.slice(0, limit).filter(m => m.score > 0);
    }

    getStats() {
        const cats = {};
        let withEmotions = 0;
        for (const m of this.memories.memories) {
            cats[m.category] = (cats[m.category] || 0) + 1;
            if (m.emotional_vector) withEmotions++;
        }
        return {
            total_memories: this.memories.memories.length,
            memories_with_emotions: withEmotions,
            categories: cats,
        };
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
// PLUGIN STATE
// ============================================================================

/** @type {McpClient | null} */
let mcpClient = null;
/** @type {LocalMemoryStore | null} */
let localStore = null;
/** @type {EmotionScorer | null} */
let emotionScorer = null;

const CONFIG_PATH = path.join(os.homedir(), '.anamnesis5', 'sillytavern-config.json');

function loadConfig() {
    if (fs.existsSync(CONFIG_PATH)) {
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    }
    return { mode: 'local', python: 'python3', serverScript: '', entityName: 'SillyTavern', emotionScoring: true };
}

function saveConfig(config) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
}

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

// ============================================================================
// PLUGIN INIT
// ============================================================================

async function init(router) {
    console.log('[anamnesis] Initializing Anamnesis Memory Bridge plugin');

    const config = loadConfig();

    // Find ST data root for secrets access
    const dataRoot = path.resolve(process.cwd(), 'data', 'default-user');
    emotionScorer = new EmotionScorer(dataRoot);
    console.log(`[anamnesis] Emotion scorer initialized (TRIBE ${TRIBE_DIMENSIONS.length} dimensions)`);

    // Initialize local store
    const dataDir = path.join(os.homedir(), '.anamnesis5', config.entityName?.toLowerCase() || 'sillytavern');
    localStore = new LocalMemoryStore(dataDir);

    // Try to start MCP server
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

    router.get('/status', (req, res) => {
        res.json({
            mode: mcpClient?.ready ? 'mcp' : 'local',
            mcpConnected: mcpClient?.ready || false,
            localMemories: localStore?.memories?.memories?.length || 0,
            emotionScoring: !!emotionScorer?._getApiKey(),
            tribeDimensions: TRIBE_DIMENSIONS.length,
        });
    });

    router.get('/config', (req, res) => { res.json(loadConfig()); });

    router.post('/config', async (req, res) => {
        try {
            const newConfig = req.body;
            saveConfig(newConfig);
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

    /** POST /api/plugins/anamnesis/remember — now with TRIBE emotion scoring */
    router.post('/remember', async (req, res) => {
        try {
            const { content, category, associations, tags, importance, emotional_intensity, summary, skip_scoring } = req.body;

            // Score emotions via Claude Haiku (unless caller provides them or opts out)
            let emotionData = req.body.emotion_data || null;
            if (!emotionData && !skip_scoring && config.emotionScoring !== false) {
                emotionData = await emotionScorer.scoreEmotions(content);
                if (emotionData) {
                    console.log(`[anamnesis] Scored ${emotionData.dominant_emotions?.length || 0} dominant emotions: ${
                        emotionData.dominant_emotions?.map(e => `${e.dimension}:${e.score}`).join(', ') || 'none'
                    }`);
                }
            }

            const finalIntensity = emotionData?.emotional_intensity ?? emotional_intensity ?? 0.5;
            const emotionTags = emotionData?.dominant_emotions?.map(e => e.dimension) || [];
            const allTags = [...(tags || []), ...emotionTags];

            // Store in local with full emotion data
            localStore.remember(content, category, associations, allTags, importance, finalIntensity, summary, emotionData);

            // Store in Synapse
            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('remember', {
                    content,
                    category: category || 'conversation',
                    associations: associations || [],
                    tags: allTags,
                    importance: importance || 5,
                    emotional_intensity: finalIntensity,
                    summary,
                });
                const parsed = extractMcpText(result);
                // Attach emotion data to response
                if (emotionData) parsed.emotion_data = emotionData;
                res.json(parsed);
            } else {
                const result = { memory_id: 'local', index_created: true, category: category || 'general' };
                if (emotionData) result.emotion_data = emotionData;
                res.json(result);
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** POST /api/plugins/anamnesis/recall — with emotional vector matching */
    router.post('/recall', async (req, res) => {
        try {
            const { prompt, limit, emotion_weight, time_filter, emotion_match } = req.body;

            // Optionally score the query's emotions for vector matching
            let queryEmotionVector = null;
            if (emotion_match && config.emotionScoring !== false) {
                const queryEmotions = await emotionScorer.scoreEmotions(prompt);
                queryEmotionVector = queryEmotions?.emotional_vector || null;
            }

            if (mcpClient?.ready) {
                const result = await mcpClient.callTool('what_comes_to_mind', {
                    prompt,
                    limit: limit || 5,
                    emotion_weight: emotion_weight || 0.3,
                    time_filter,
                });
                const parsed = extractMcpText(result);

                if (parsed?.error && parsed.error.includes('index not built')) {
                    console.log('[anamnesis] Synapse vector index not yet built, falling back to local store');
                    const memories = localStore.recall(prompt, limit || 5, queryEmotionVector);
                    res.json({ success: true, count: memories.length, memories, note: 'local_fallback' });
                } else {
                    // If we have local emotion vectors, enrich Synapse results
                    if (parsed?.memories && queryEmotionVector) {
                        for (const mem of parsed.memories) {
                            const localMem = localStore.memories.memories.find(m =>
                                m.content === mem.content || m.id === mem.id
                            );
                            if (localMem?.emotional_vector) {
                                mem.emotion_similarity = emotionalCosineSimilarity(
                                    queryEmotionVector, localMem.emotional_vector
                                );
                                mem.emotional_vector = localMem.emotional_vector;
                                mem.dominant_emotions = localMem.dominant_emotions;
                            }
                        }
                    }
                    res.json(parsed);
                }
            } else {
                const memories = localStore.recall(prompt, limit || 5, queryEmotionVector);
                res.json({ success: true, count: memories.length, memories });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** POST /api/plugins/anamnesis/score-emotions — standalone scoring endpoint */
    router.post('/score-emotions', async (req, res) => {
        try {
            const { text } = req.body;
            if (!text) return res.status(400).json({ error: 'text is required' });

            const result = await emotionScorer.scoreEmotions(text);
            if (result) {
                res.json({ success: true, ...result });
            } else {
                res.json({ success: false, error: 'Emotion scoring unavailable (no API key)' });
            }
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    /** GET /api/plugins/anamnesis/dimensions — list all TRIBE dimensions */
    router.get('/dimensions', (req, res) => {
        res.json({ dimensions: TRIBE_DIMENSIONS, count: TRIBE_DIMENSIONS.length });
    });

    router.get('/categories', async (req, res) => {
        try {
            if (mcpClient?.ready) {
                res.json(extractMcpText(await mcpClient.callTool('list_categories', {})));
            } else {
                res.json({ success: true, categories: localStore.listCategories() });
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/stats', async (req, res) => {
        try {
            if (mcpClient?.ready) {
                const mcpStats = extractMcpText(await mcpClient.callTool('get_graph_stats', {}));
                // Enrich with local emotion stats
                const localStats = localStore.getStats();
                if (mcpStats?.stats) mcpStats.stats.memories_with_emotions = localStats.memories_with_emotions;
                res.json(mcpStats);
            } else {
                res.json({ success: true, stats: localStore.getStats() });
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.get('/bootstrap', async (req, res) => {
        try {
            if (mcpClient?.ready) {
                res.json(extractMcpText(await mcpClient.callTool('load_bootstrap', {})));
            } else {
                res.json({ success: false, message: 'Bootstrap requires MCP server' });
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    router.post('/index-search', async (req, res) => {
        try {
            const { category, associations, tags, min_importance, limit } = req.body;
            if (mcpClient?.ready) {
                res.json(extractMcpText(await mcpClient.callTool('index_search', {
                    category, associations, tags,
                    min_importance: min_importance || 0,
                    limit: limit || 50,
                })));
            } else {
                let results = localStore.memories.memories;
                if (category) results = results.filter(m => m.category === category);
                if (min_importance) results = results.filter(m => m.importance >= min_importance);
                res.json({ success: true, count: results.length, results: results.slice(0, limit || 50) });
            }
        } catch (err) { res.status(500).json({ error: err.message }); }
    });

    console.log('[anamnesis] Plugin routes registered under /api/plugins/anamnesis/');
}

function exit() {
    if (mcpClient) { mcpClient.stop(); mcpClient = null; }
    console.log('[anamnesis] Plugin shut down');
}

module.exports = { info, init, exit };
