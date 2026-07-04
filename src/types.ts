// ========== ASR 协议 ==========
export type ASRProtocol = "openai-whisper" | "volcengine" | "aliyun-dashscope" | "xunfei" | "tencent" | "baidu" | "huawei" | "local-openai";

export type ASRProviderPreset =
  | "openai" | "volcengine" | "aliyun" | "xunfei" | "tencent" | "baidu" | "huawei"
  | "local-openai" | "custom";

export interface ASRConfig {
  protocol: ASRProtocol;
  apiKey?: string;
  secretKey?: string;
  apiUrl?: string;
  resourceId?: string;
  appId?: string;
  region?: string;
  model?: string;
  localEndpoint?: string;
  language: string;
  enableSpeakerDiarization: boolean;
}

export interface ASRModelEntry {
  id: string;
  preset: ASRProviderPreset;
  protocol: ASRProtocol;
  displayName?: string;
  apiKey?: string;
  secretKey?: string;
  apiUrl?: string;
  resourceId?: string;
  appId?: string;
  region?: string;
  model?: string;
  localEndpoint?: string;
  language: string;
  enableSpeakerDiarization: boolean;
  speakerDiarization?: boolean;
  asrType?: string;
}

// ========== 说话人识别 / 声纹配置 ==========
export type SpeakerModelType = "none" | "builtin" | "custom";

export interface SpeakerDiarizationConfig {
  enabled: boolean;
  modelType: SpeakerModelType;
  customEndpoint?: string;
  apiKey?: string;
  autoVoiceprint: boolean;
  minSpeakers: number;
  maxSpeakers: number;
}

export interface VoiceprintEntry {
  id: string;
  name: string;
  audioSamplePath?: string;
  description?: string;
}

// ========== LLM 配置 ==========
export type LLMProviderType = "anthropic" | "openai" | "zhipu" | "deepseek" | "minimax" | "google" | "aliyun" | "baidu" | "bytedance" | "tencent" | "huawei" | "moonshot" | "xunfei" | "mistral" | "meta" | "custom";

export interface LLMConfig {
  provider: LLMProviderType;
  apiFormat?: ApiFormat;
  apiKey: string;
  apiUrl: string;
  model: string;
  maxTokens: number;
  temperature: number;
  systemPrompt?: string;
}

export type ApiFormat = "openai" | "anthropic";

export interface LLMModelEntry {
  id: string;
  provider: LLMProviderType;
  apiFormat?: ApiFormat;
  apiKey: string;
  apiUrl: string;
  model: string;
  displayName?: string;
  contextWindow?: number;
  maxTokens?: number;
  temperature?: number;
}

// ========== 模板 ==========
export type TemplateType =
  | "business-meeting" | "academic-exchange" | "class-summary" | "interview"
  | "general" | "custom"
  | "reading-notes" | "thesis-discussion" | "news-interview" | "user-research"
  | "sales-meeting" | "customer-call" | "business-negotiation"
  | "government-meeting" | "policy-briefing" | "party-study"
  | "product-review" | "tech-proposal" | "sprint-retro";

export interface SummaryTemplate {
  type: TemplateType;
  name: string;
  description: string;
  systemPrompt: string;
  outputFormat: string;
}

// ========== 热词 ==========
export interface HotWord {
  word: string;
  weight?: number;
  category?: string;
}

// ========== 处理任务 ==========
export interface TranscriptionTask {
  id: string;
  mp3Urls: string[];
  asrConfig: ASRConfig;
  speakerConfig: SpeakerDiarizationConfig;
  llmConfig: LLMConfig;
  template: TemplateType;
  customPrompt?: string;
  hotWords: HotWord[];
  voiceprintLibrary: VoiceprintEntry[];
  createdAt: number;
}

// ========== 处理结果 ==========
export interface TranscriptionResult {
  taskId: string;
  transcript: TranscriptSegment[];
  summary: string;
  keywords: string[];
  actionItems: string[];
  duration: number;
  language: string;
  speakerCount: number;
}

export interface TranscriptSegment {
  startTime: string;
  endTime: string;
  speaker: string;
  text: string;
}

// ========== 插件设置 ==========
export interface SonicNoteGeekSettings {
  asr: ASRConfig;
  asrModels: ASRModelEntry[];
  activeAsrModelId: string;
  speakerDiarization: SpeakerDiarizationConfig;
  llm: LLMConfig;
  llmModels: LLMModelEntry[];
  activeModelId: string;
  customTemplates: SummaryTemplate[];
  industry: string;
  hotWords: HotWord[];
  voiceprintLibrary: VoiceprintEntry[];
}
