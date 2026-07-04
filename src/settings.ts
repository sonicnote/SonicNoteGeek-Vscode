import * as vscode from "vscode";
import type { SonicNoteGeekSettings } from "./types";

export const DEFAULT_SETTINGS: SonicNoteGeekSettings = {
  asr: {
    protocol: "openai-whisper",
    apiKey: "",
    apiUrl: "https://api.openai.com/v1/audio/transcriptions",
    model: "whisper-1",
    language: "zh",
    enableSpeakerDiarization: false,
  },
  asrModels: [],
  activeAsrModelId: "",
  speakerDiarization: {
    enabled: true,
    modelType: "builtin",
    customEndpoint: "",
    apiKey: "",
    autoVoiceprint: false,
    minSpeakers: 1,
    maxSpeakers: 10,
  },
  llm: {
    provider: "anthropic",
    apiKey: "",
    apiUrl: "https://api.anthropic.com/v1/messages",
    model: "claude-sonnet-4-6",
    maxTokens: 4096,
    temperature: 0.7,
  },
  llmModels: [],
  activeModelId: "",
  customTemplates: [],
  industry: "",
  hotWords: [],
  voiceprintLibrary: [],
};

function getConfig(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration("sonicnoteGeek");
}

export function loadSettings(context: vscode.ExtensionContext): SonicNoteGeekSettings {
  const config = getConfig();
  const persisted = context.globalState.get<SonicNoteGeekSettings>("sonicnote-settings");

  const settings: SonicNoteGeekSettings = {
    asr: {
      protocol: (config.get("asr.protocol") as any) || DEFAULT_SETTINGS.asr.protocol,
      apiKey: config.get("asr.apiKey") || persisted?.asr.apiKey || "",
      apiUrl: config.get("asr.apiUrl") || DEFAULT_SETTINGS.asr.apiUrl,
      model: config.get("asr.model") || DEFAULT_SETTINGS.asr.model,
      language: config.get("asr.language") || DEFAULT_SETTINGS.asr.language,
      secretKey: config.get("asr.secretKey") || persisted?.asr.secretKey || "",
      appId: config.get("asr.appId") || persisted?.asr.appId || "",
      resourceId: config.get("asr.resourceId") || persisted?.asr.resourceId || "",
      localEndpoint: config.get("asr.localEndpoint") || DEFAULT_SETTINGS.asr.localEndpoint,
      enableSpeakerDiarization: config.get("asr.enableSpeakerDiarization") ?? DEFAULT_SETTINGS.asr.enableSpeakerDiarization,
    },
    asrModels: persisted?.asrModels || [],
    activeAsrModelId: persisted?.activeAsrModelId || "",
    speakerDiarization: {
      enabled: config.get("speaker.enabled") ?? DEFAULT_SETTINGS.speakerDiarization.enabled,
      modelType: (config.get("speaker.modelType") as any) || DEFAULT_SETTINGS.speakerDiarization.modelType,
      customEndpoint: config.get("speaker.customEndpoint") || persisted?.speakerDiarization.customEndpoint || "",
      apiKey: config.get("speaker.apiKey") || persisted?.speakerDiarization.apiKey || "",
      autoVoiceprint: config.get("speaker.autoVoiceprint") ?? DEFAULT_SETTINGS.speakerDiarization.autoVoiceprint,
      minSpeakers: persisted?.speakerDiarization.minSpeakers || DEFAULT_SETTINGS.speakerDiarization.minSpeakers,
      maxSpeakers: persisted?.speakerDiarization.maxSpeakers || DEFAULT_SETTINGS.speakerDiarization.maxSpeakers,
    },
    llm: {
      provider: (config.get("llm.provider") as any) || DEFAULT_SETTINGS.llm.provider,
      apiKey: config.get("llm.apiKey") || persisted?.llm.apiKey || "",
      apiUrl: config.get("llm.apiUrl") || DEFAULT_SETTINGS.llm.apiUrl,
      model: config.get("llm.model") || DEFAULT_SETTINGS.llm.model,
      maxTokens: config.get("llm.maxTokens") || DEFAULT_SETTINGS.llm.maxTokens,
      temperature: config.get("llm.temperature") ?? DEFAULT_SETTINGS.llm.temperature,
    },
    llmModels: persisted?.llmModels || [],
    activeModelId: persisted?.activeModelId || "",
    customTemplates: persisted?.customTemplates || [],
    industry: persisted?.industry || "",
    hotWords: persisted?.hotWords || [],
    voiceprintLibrary: persisted?.voiceprintLibrary || [],
  };

  return settings;
}

export async function saveSettings(context: vscode.ExtensionContext, settings: SonicNoteGeekSettings): Promise<void> {
  await context.globalState.update("sonicnote-settings", settings);
}

export function getActiveASRConfig(settings: SonicNoteGeekSettings): typeof settings.asr {
  const activeModel = settings.asrModels.find(m => m.id === settings.activeAsrModelId);
  if (activeModel) {
    return {
      protocol: activeModel.protocol,
      apiKey: activeModel.apiKey,
      secretKey: activeModel.secretKey,
      apiUrl: activeModel.apiUrl,
      resourceId: activeModel.resourceId,
      appId: activeModel.appId,
      region: activeModel.region,
      model: activeModel.model,
      localEndpoint: activeModel.localEndpoint,
      language: activeModel.language,
      enableSpeakerDiarization: activeModel.enableSpeakerDiarization,
    };
  }
  return settings.asr;
}

export function getActiveASRModelName(settings: SonicNoteGeekSettings): string {
  const active = settings.asrModels.find(m => m.id === settings.activeAsrModelId);
  return active?.displayName || active?.preset || "默认配置";
}

export function getActiveLLMConfig(settings: SonicNoteGeekSettings): typeof settings.llm {
  const activeModel = settings.llmModels.find(m => m.id === settings.activeModelId);
  if (activeModel) {
    return {
      provider: activeModel.provider,
      apiFormat: activeModel.apiFormat,
      apiKey: activeModel.apiKey,
      apiUrl: activeModel.apiUrl,
      model: activeModel.model,
      maxTokens: activeModel.maxTokens || 4096,
      temperature: activeModel.temperature ?? 0.7,
    };
  }
  return settings.llm;
}

export function getActiveLLMModelName(settings: SonicNoteGeekSettings): string {
  const active = settings.llmModels.find(m => m.id === settings.activeModelId);
  return active?.displayName || active?.provider || settings.llm.provider;
}
