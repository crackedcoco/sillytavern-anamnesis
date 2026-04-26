import {
    eventSource,
    event_types,
    extension_prompt_types,
    extension_prompt_roles,
    getRequestHeaders,
    saveSettingsDebounced,
    setExtensionPrompt,
} from '../../../../script.js';
import {
    extension_settings,
    getContext,
    renderExtensionTemplateAsync,
} from '../../../extensions.js';

// ============================================================================
// MODULE CONFIG
// ============================================================================

const MODULE_NAME = 'anamnesis';
const EXTENSION_PROMPT_TAG = '5_anamnesis';
const API_BASE = '/api/plugins/anamnesis';

const defaultSettings = {
    enabled: true,
    autoRemember: false,
    recallLimit: 5,
    emotionWeight: 0.3,
    depth: 2,
    position: extension_prompt_types.IN_PROMPT,
    role: extension_prompt_roles.SYSTEM,
    template: '[Anamnesis Memory - relevant past context:\n{{memories}}]',
};

let lastInjectedMemories = '';

// ============================================================================
// API HELPERS
// ============================================================================

async function apiGet(endpoint) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'GET',
        headers: getRequestHeaders(),
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
}

async function apiPost(endpoint, body) {
    const response = await fetch(`${API_BASE}${endpoint}`, {
        method: 'POST',
        headers: getRequestHeaders(),
        body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`API error: ${response.status}`);
    return response.json();
}

// ============================================================================
// CORE FUNCTIONS
// ============================================================================

/**
 * Query Anamnesis for relevant memories and inject them into the prompt.
 * Called before each generation.
 * @param {string} type - Generation type (e.g. 'normal', 'quiet', 'swipe', etc.)
 * @param {object} args - Generation arguments
 * @param {boolean} dryRun - Whether this is a dry run (no actual generation)
 */
async function onGenerationStarted(type, args, dryRun) {
    // Skip quiet prompts (internal extension calls) and dry runs
    if (type === 'quiet' || dryRun) return;

    const settings = extension_settings[MODULE_NAME];
    if (!settings?.enabled) {
        setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0);
        return;
    }

    try {
        // Build a recall prompt from recent chat context
        const recallPrompt = buildRecallPrompt();
        if (!recallPrompt) return;

        const result = await apiPost('/recall', {
            prompt: recallPrompt,
            limit: settings.recallLimit ?? defaultSettings.recallLimit,
            emotion_weight: settings.emotionWeight ?? defaultSettings.emotionWeight,
        });

        const memories = result?.memories || [];
        if (memories.length === 0) {
            setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0);
            lastInjectedMemories = '';
            return;
        }

        // Format memories for injection
        const formatted = formatMemories(memories);
        const template = settings.template || defaultSettings.template;
        const injectionText = template.replace('{{memories}}', formatted);

        const position = settings.position ?? defaultSettings.position;
        const depth = settings.depth ?? defaultSettings.depth;
        const role = settings.role ?? defaultSettings.role;

        setExtensionPrompt(EXTENSION_PROMPT_TAG, injectionText, position, depth, false, role);
        lastInjectedMemories = formatted;

        // Update preview
        const previewEl = document.getElementById('anamnesis_preview_content');
        if (previewEl) {
            previewEl.value = formatted;
            document.getElementById('anamnesis_preview').style.display = '';
        }
    } catch (err) {
        console.error('[anamnesis] Recall failed:', err);
    }
}

/**
 * Optionally auto-remember new messages.
 * @param {number} messageIndex - Index of the message in the chat array
 */
async function onMessageReceived(messageIndex) {
    if (!extension_settings[MODULE_NAME]?.autoRemember) return;

    try {
        const context = getContext();
        if (!context?.chat) return;

        const message = context.chat[messageIndex];
        if (!message || message.is_system) return;

        const content = message.mes;
        if (!content || content.length < 20) return;

        await apiPost('/remember', {
            content: content.slice(0, 2000),
            category: 'conversation',
            associations: [message.is_user ? (context.name1 || 'user') : (context.name2 || 'character')],
            tags: ['auto', 'chat'],
            importance: 4,
            emotional_intensity: 0.3,
        });
    } catch (err) {
        console.error('[anamnesis] Auto-remember failed:', err);
    }
}

/**
 * Build a recall prompt from recent chat messages.
 */
function buildRecallPrompt() {
    const context = getContext();
    const chat = context?.chat;
    if (!chat || chat.length === 0) return null;

    // Take the last few messages as recall context
    const recent = chat.slice(-5).filter(m => !m.is_system && m.mes);
    if (recent.length === 0) return null;

    return recent.map(m => m.mes).join('\n').slice(0, 1000);
}

/**
 * Format memories into readable text for prompt injection.
 */
function formatMemories(memories) {
    return memories.map((m, i) => {
        const importance = m.importance ? ` (importance: ${m.importance}/10)` : '';
        const category = m.category ? ` [${m.category}]` : '';
        const content = m.content || m.summary || '';
        return `${i + 1}. ${content.slice(0, 500)}${category}${importance}`;
    }).join('\n');
}

// ============================================================================
// SETTINGS UI
// ============================================================================

function loadSettings() {
    if (!extension_settings[MODULE_NAME]) {
        extension_settings[MODULE_NAME] = {};
    }

    for (const key of Object.keys(defaultSettings)) {
        if (extension_settings[MODULE_NAME][key] === undefined) {
            extension_settings[MODULE_NAME][key] = defaultSettings[key];
        }
    }

    // Populate UI
    $('#anamnesis_enabled').prop('checked', extension_settings[MODULE_NAME].enabled);
    $('#anamnesis_auto_remember').prop('checked', extension_settings[MODULE_NAME].autoRemember);
    $('#anamnesis_recall_limit').val(extension_settings[MODULE_NAME].recallLimit);
    $('#anamnesis_recall_limit_value').text(extension_settings[MODULE_NAME].recallLimit);
    $('#anamnesis_emotion_weight').val(extension_settings[MODULE_NAME].emotionWeight);
    $('#anamnesis_emotion_weight_value').text(extension_settings[MODULE_NAME].emotionWeight);
    $('#anamnesis_depth').val(extension_settings[MODULE_NAME].depth);
    $('#anamnesis_depth_value').text(extension_settings[MODULE_NAME].depth);
    $('#anamnesis_position').val(extension_settings[MODULE_NAME].position);
    $('#anamnesis_role').val(extension_settings[MODULE_NAME].role);
    $('#anamnesis_template').val(extension_settings[MODULE_NAME].template);
}

function bindEvents() {
    // Setting toggles
    $('#anamnesis_enabled').on('change', function () {
        extension_settings[MODULE_NAME].enabled = !!$(this).prop('checked');
        if (!extension_settings[MODULE_NAME].enabled) {
            setExtensionPrompt(EXTENSION_PROMPT_TAG, '', extension_prompt_types.IN_PROMPT, 0);
        }
        saveSettingsDebounced();
    });

    $('#anamnesis_auto_remember').on('change', function () {
        extension_settings[MODULE_NAME].autoRemember = !!$(this).prop('checked');
        saveSettingsDebounced();
    });

    $('#anamnesis_recall_limit').on('input', function () {
        const val = parseInt($(this).val());
        extension_settings[MODULE_NAME].recallLimit = val;
        $('#anamnesis_recall_limit_value').text(val);
        saveSettingsDebounced();
    });

    $('#anamnesis_emotion_weight').on('input', function () {
        const val = parseFloat($(this).val());
        extension_settings[MODULE_NAME].emotionWeight = val;
        $('#anamnesis_emotion_weight_value').text(val);
        saveSettingsDebounced();
    });

    $('#anamnesis_depth').on('input', function () {
        const val = parseInt($(this).val());
        extension_settings[MODULE_NAME].depth = val;
        $('#anamnesis_depth_value').text(val);
        saveSettingsDebounced();
    });

    $('#anamnesis_position').on('change', function () {
        extension_settings[MODULE_NAME].position = parseInt($(this).val());
        saveSettingsDebounced();
    });

    $('#anamnesis_role').on('change', function () {
        extension_settings[MODULE_NAME].role = parseInt($(this).val());
        saveSettingsDebounced();
    });

    $('#anamnesis_template').on('change', function () {
        extension_settings[MODULE_NAME].template = $(this).val();
        saveSettingsDebounced();
    });

    // Test recall button
    $('#anamnesis_test_recall').on('click', async function () {
        try {
            const prompt = buildRecallPrompt() || 'test recall';
            const result = await apiPost('/recall', {
                prompt,
                limit: extension_settings[MODULE_NAME].recallLimit || 5,
                emotion_weight: extension_settings[MODULE_NAME].emotionWeight || 0.3,
            });
            const memories = result?.memories || [];
            const formatted = memories.length > 0
                ? formatMemories(memories)
                : '(No memories found)';
            $('#anamnesis_preview_content').val(formatted);
            $('#anamnesis_preview').show();
        } catch (err) {
            $('#anamnesis_preview_content').val(`Error: ${err.message}`);
            $('#anamnesis_preview').show();
        }
    });

    // Stats button
    $('#anamnesis_view_stats').on('click', async function () {
        try {
            const stats = await apiGet('/stats');
            const text = JSON.stringify(stats, null, 2);
            $('#anamnesis_preview_content').val(text);
            $('#anamnesis_preview').show();
        } catch (err) {
            $('#anamnesis_preview_content').val(`Error: ${err.message}`);
            $('#anamnesis_preview').show();
        }
    });

    // Manual save memory
    $('#anamnesis_manual_save').on('click', async function () {
        const content = $('#anamnesis_manual_content').val()?.trim();
        if (!content) return;

        try {
            const category = $('#anamnesis_manual_category').val();
            await apiPost('/remember', {
                content,
                category,
                associations: [],
                tags: ['manual'],
                importance: 6,
                emotional_intensity: 0.5,
            });
            $('#anamnesis_manual_content').val('');
            toastr.success('Memory saved');
            refreshStatus();
        } catch (err) {
            toastr.error(`Failed to save: ${err.message}`);
        }
    });

    // Config panel toggle
    $('#anamnesis_config_toggle').on('click', function () {
        $('#anamnesis_config_panel').toggle();
    });

    // Mode toggle
    $('#anamnesis_mode').on('change', function () {
        const isMcp = $(this).val() === 'mcp';
        $('#anamnesis_mcp_fields').toggle(isMcp);
    });

    // Save server config
    $('#anamnesis_save_config').on('click', async function () {
        try {
            const config = {
                mode: $('#anamnesis_mode').val(),
                python: $('#anamnesis_python').val(),
                serverScript: $('#anamnesis_server_script').val(),
                entityName: $('#anamnesis_entity_name').val(),
            };
            await apiPost('/config', config);
            toastr.success('Server config saved');
            refreshStatus();
        } catch (err) {
            toastr.error(`Config save failed: ${err.message}`);
        }
    });
}

async function refreshStatus() {
    try {
        const status = await apiGet('/status');
        const dot = document.getElementById('anamnesis_status_dot');
        const text = document.getElementById('anamnesis_status_text');
        const count = document.getElementById('anamnesis_memory_count');

        if (status.mcpConnected) {
            dot.className = 'anamnesis-dot online';
            text.textContent = 'MCP Connected (Synapse)';
        } else {
            dot.className = 'anamnesis-dot offline';
            text.textContent = `Local mode`;
        }
        count.textContent = `${status.localMemories || 0} memories`;

        // Load server config into UI
        const config = await apiGet('/config');
        $('#anamnesis_mode').val(config.mode || 'local').trigger('change');
        $('#anamnesis_python').val(config.python || 'python3');
        $('#anamnesis_server_script').val(config.serverScript || '');
        $('#anamnesis_entity_name').val(config.entityName || 'SillyTavern');
    } catch (err) {
        const dot = document.getElementById('anamnesis_status_dot');
        const text = document.getElementById('anamnesis_status_text');
        if (dot) dot.className = 'anamnesis-dot error';
        if (text) text.textContent = 'Plugin not loaded (enable server plugins)';
    }
}

// ============================================================================
// INIT
// ============================================================================

jQuery(async () => {
    const settingsHtml = await renderExtensionTemplateAsync('third-party/anamnesis', 'settings');
    $('#extensions_settings2').append(settingsHtml);

    loadSettings();
    bindEvents();

    // Hook into generation pipeline — inject memories before each generation
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    // Hook into message received — auto-remember if enabled
    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.MESSAGE_SENT, onMessageReceived);

    // Initial status check
    refreshStatus();

    console.log('[anamnesis] Extension loaded');
});
