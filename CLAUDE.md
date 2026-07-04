# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**SonicNoteGeek** is a VS Code extension (`sonicnote-geek`) for audio transcription, intelligent summarization, and cloud sync
from SonicNote (妙记).

- ASR: speech-to-text via 8 cloud/local engines
- Speaker diarization + voiceprint recognition
- LLM summarization with 19 built-in templates (Chinese)
- Sync: download recordings/transcripts/notes from SonicNote server → local Markdown files

## Build & Dev

```bash
npm run build    # esbuild bundle: src/extension.ts → dist/extension.js
npm run watch    # esbuild watch (auto-rebuild)
npm run lint     # tsc --noEmit (type-check)
```

Source → `dist/extension.js` (bundled CJS, `vscode` externalized).  
F5 in VS Code = Extension Development Host.

## Architecture

### Core Pipeline
```
Markdown file → extract MP3 links → download → ASR → speaker diarization → LLM summarization → Markdown output
```

### Key Modules

| File | Role |
|---|---|
| `src/extension.ts` | Activation, webview panel (~1500 LOC inline HTML/CSS/JS), TreeView sidebar, command registration, ~40 webview message handlers |
| `src/processor.ts` | `AudioProcessor` class — 8 ASR protocol implementations, HTTP, speaker diarization (builtin heuristic + voiceprint service), ffmpeg audio cutting, LLM calls (Anthropic + OpenAI-compatible) |
| `src/types.ts` | All TS interfaces |
| `src/settings.ts` | Settings persistence: VS Code config + `globalState` merge |
| `src/templates.ts` | 19 `SummaryTemplate` objects with `systemPrompt` (Chinese), 6 categories |
| `src/utils/mp3-extractor.ts` | Regex MP3 extraction from Markdown (YAML frontmatter, embeds, wikilinks, bare URLs, HTML audio) |
| `src/utils/output-generator.ts` | Final Markdown assembly: summary → keywords → actions → transcript |
| `src/sync/` | **SonicNote cloud sync** — copies from SonicNoteSync-Vscode (these files are NOT modified) |

### Sync Module (`src/sync/`)
- `types.ts` — sync data types & settings
- `api.ts` — `SonicNoteApiClient` (login, list, detail, transcript, summary, study report)
- `sync.ts` — `SyncService` (incremental sync, smart rename)
- `formatter.ts` — file name sanitize, frontmatter, Markdown generation
- `integration.ts` — wiring: command registration, globalState, auto-sync timer
- `sidebar.ts` — webview sidebar provider (backup)
- `settings-panel.ts` — sync settings webview panel

### Sidebar TreeView
Left sidebar shows:
- ⚙️ 设置 → opens sync settings panel
- 🔄 文件同步 → triggers sync
- 📁 文件目录 → expanded tree of synced MD files from `sonicnoteGeek.sync.syncFolder`

### Settings Key Paths
- **VS Code config**: `sonicnoteGeek.*` (ASR, speaker, LLM), `sonicnoteGeek.sync.*` (sync)
- **globalState**: model lists (`asrModels`, `llmModels`), custom templates, hot words, voiceprint library, sync auth token/state

### ASR Protocols
- `local-openai` / `xunfei` — read local files, upload binary
- All other cloud ASRs — require HTTP URLs (extension downloads first)
- Speaker results from ASR: `__ASR__` → `speaker_N` → `说话人N`

### Dead Code
`src/utils/model-list.ts`, `asr-model-list.ts`, `asr-guide.ts`, `voiceprint-guide.ts` import from `"obsidian"` and are NOT used by `extension.ts`. Excluded from `tsconfig.json`.

## Key Commands (VS Code)
| Command ID | Description |
|---|---|
| `sonicnote-geek.openTranscribePanel` | Open transcribe panel |
| `sonicnote-geek.quickTranscribe` | Quick transcribe with default settings |
| `sonicnote-geek.sync` | Trigger SonicNote sync |
| `sonicnote-geek.openSyncSettings` | Open sync settings panel |

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
