# SillyTavern Anamnesis Memory Bridge

Integrates [Anamnesis 5.0](https://github.com/AImakerextraordinaire/Anamnesis_5.0) (Synapse Neural DB) into SillyTavern as a persistent, graph-based memory system with spreading activation and emotional recall.

## What This Does

Before every LLM generation, this extension queries your memory graph for relevant past context and injects it into the prompt. Unlike SillyTavern's built-in summarization (lossy rolling summary) or vector storage (flat cosine-only search), Anamnesis uses:

- **HNSW vector search** (O(log N) instead of brute-force O(N))
- **Spreading activation** across a graph of connected memories (3-hop traversal)
- **Emotional gravity** that boosts high-significance memories in recall
- **14-field metadata** per memory (importance, emotion, category, tags, associations, entities)
- **Cross-chat persistence** - memories survive across chat sessions

## Architecture

```
SillyTavern (Node.js)
    |
    +-- Server Plugin (plugins/anamnesis/)
    |       |
    |       +-- MCP Client ---- JSON-RPC/stdio ----> Anamnesis MCP Server (Python)
    |       |                                              |-- Synapse Neural DB (Rust)
    |       |                                              |-- sentence-transformers (384-dim)
    |       |                                              +-- 13 MCP tools
    |       +-- Local JSON Store (keyword fallback)
    |
    +-- Client Extension (extensions/third-party/anamnesis/)
            |-- GENERATION_STARTED hook
            |-- setExtensionPrompt() injection
            +-- Settings UI panel
```

## Installation

### Prerequisites

- [SillyTavern](https://github.com/SillyTavern/SillyTavern) 1.12+
- Node.js 18+
- Python 3.8+ (for MCP mode)
- Rust toolchain (for building Synapse from source)

### Step 1: Enable Server Plugins

In your SillyTavern `config.yaml`:

```yaml
enableServerPlugins: true
```

### Step 2: Install the Server Plugin

```bash
# Copy server plugin to SillyTavern plugins directory
cp -r server-plugin/ /path/to/SillyTavern/plugins/anamnesis/
```

### Step 3: Install the Client Extension

```bash
# Copy client extension to SillyTavern extensions
cp -r client-extension/ /path/to/SillyTavern/public/scripts/extensions/third-party/anamnesis/
```

### Step 4: Restart SillyTavern

The extension will start in **local mode** (JSON keyword search) immediately.

### Step 5 (Optional): Enable Full Synapse Backend

To use the full graph DB with spreading activation:

1. Clone and build Synapse:
```bash
git clone https://github.com/AImakerextraordinaire/Anamnesis_5.0.git
cd Anamnesis_5.0

# Create Python module structure
mkdir -p python/synapse
touch python/synapse/__init__.py
cp python/synapse.pyi python/synapse/__init__.pyi

# Build the Rust wheel
pip install maturin
maturin build --release

# Install
pip install target/wheels/synapse_db-*.whl
pip install sentence-transformers mcp httpx
```

2. Fix the `__init__.py` to re-export:
```python
# In site-packages/synapse/__init__.py
from synapse.synapse import *
```

3. Configure MCP mode in the SillyTavern extension settings panel, or create `~/.anamnesis5/sillytavern-config.json`:
```json
{
  "mode": "mcp",
  "python": "python3",
  "serverScript": "/path/to/Anamnesis_5.0/anamnesis_5_mcp_server.py",
  "entityName": "SillyTavern"
}
```

## Comparison: Memory Systems

| Measure | ST Summarize | ST Vector Storage | Anamnesis/Synapse |
|---------|-------------|-------------------|-------------------|
| Search algorithm | None (LLM rewrites summary) | Brute-force cosine O(N) | HNSW O(log N) + graph walk |
| Ranking | N/A | Cosine similarity only | Cosine + emotional gravity blend |
| Relationships | None | None (flat points) | Graph edges, 3-hop spreading activation |
| Information loss | High (lossy compression) | None (stores original) | None (stores original + metadata) |
| Cross-chat | No | Per-character only | Global |
| Cost per message | 1 LLM call every N msgs | 1 embedding (local/free) | 1 embedding + Rust ops (local/free) |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Enable memory injection | On | Toggle the extension |
| Auto-remember messages | Off | Automatically store each chat message |
| Memories to recall | 5 | How many memories to inject per generation |
| Emotion weight | 0.3 | Balance: 0 = pure semantic, 1 = pure emotional |
| Injection depth | 2 | Position in message stack |
| Injection position | In prompt | System area vs in-chat |
| Message role | System | System / User / Assistant |
| Template | Customizable | Wrapper text around `{{memories}}` |

## API Endpoints

When the server plugin is loaded, these routes are available:

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/plugins/anamnesis/status` | GET | Connection status and memory count |
| `/api/plugins/anamnesis/config` | GET/POST | Read/write MCP server configuration |
| `/api/plugins/anamnesis/remember` | POST | Store a memory |
| `/api/plugins/anamnesis/recall` | POST | Retrieve relevant memories |
| `/api/plugins/anamnesis/categories` | GET | List memory categories |
| `/api/plugins/anamnesis/stats` | GET | Memory graph statistics |
| `/api/plugins/anamnesis/bootstrap` | GET | Load bootstrap index (MCP only) |
| `/api/plugins/anamnesis/index-search` | POST | Filtered index search |

## Credits

- **Anamnesis 5.0 / Synapse Neural DB**: [AImakerextraordinaire](https://github.com/AImakerextraordinaire/Anamnesis_5.0) (Rex, Claude, Kiro)
- **SillyTavern**: [SillyTavern](https://github.com/SillyTavern/SillyTavern)
- **Integration**: Built with Claude Code

## License

MIT
