/** 前后端共同使用的数据契约；外部 JSON 仍须在运行时校验。 */
export type Style = 'dark' | 'light';
export type Layout = 'hero' | 'statement' | 'cards' | 'metrics' | 'timeline' | 'comparison' | 'closing';
export type Stage = 'outline' | 'samples' | 'ready';
export type Mode = 'example' | 'live';
export type ExportFormat = 'pdf' | 'pptx';
export type GenerationPhase = 'samples' | 'all';
export type Usage = Record<string, unknown>;
export interface Bullet { title: string; body: string }
export interface Metric { value: string; label: string; note: string }
export interface ImageTask {
  fingerprint: string; model: string; status: string; createdAt: string;
  taskId?: string; requestId?: string; retryAt?: string;
}
export interface Slide {
  id: string; title: string; kicker: string; subtitle: string; brand?: string; layout: Layout;
  bullets: Bullet[]; metrics: Metric[]; imagePrompt: string; needsImage: boolean;
  notes: string; image: string | null; imageModel: string | null;
  imageTask: ImageTask | null; revision: number; imageReference?: string; imageUsage?: Usage;
  imageMode?: 'full-slide' | 'background'; pageStyle?: Style;
}
export interface Brief { topic: string; notes: string; pages: number; style: Style; pageContents?: string[] }
export interface Plan { title: string; summary: string; slides: Slide[] }
export interface GeneratedPlan extends Plan { source: 'example' | 'qwen'; textModel: string | null; usage?: Usage }
export interface ImageJob {
  id: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
  phase: GenerationPhase | 'single'; total: number; done: number; error: string | null; current?: string;
}
export interface PublicProject extends Brief, Plan {
  id: string; source: 'example' | 'qwen'; stage: Stage; version: number;
  createdAt: string; updatedAt: string; job: ImageJob | null; textModel?: string | null; usage?: Usage;
}
export interface Project extends PublicProject { owner: string }
export interface ProjectSummary {
  id: string; title: string; source: PublicProject['source']; stage: Stage; style: Style;
  pages: number; version: number; updatedAt: string;
}
export interface ServiceStatus {
  authRequired: boolean; bailianConfigured: boolean; textProvider: 'bailian-direct';
  textModel: string; imageModel: string; imageQueue: number; defaultPages: number;
}
export interface CreateProjectRequest extends Brief { mode: Mode }
export interface PatchProjectRequest { version: number; title?: string; style?: Style; slides?: Slide[] }
export interface RefineRequest { version: number; instruction: string }
export interface GenerateRequest { version: number; phase: GenerationPhase; confirm: boolean }
export interface RegenerateRequest { version: number; confirm: boolean }
export interface UploadRequest { version: number; data: string }
export interface RestoreRequest { version: number; restoreVersion: number }
export interface ExportRequest { version: number; format: ExportFormat; scope?: 'generated' }
export interface ExportResponse { url: string; filename: string }
export interface HistoryResponse { versions: number[] }
export interface LoginRequest { password: string }
export interface ApiResponses {
  status: ServiceStatus; project: PublicProject; projects: ProjectSummary[];
  history: HistoryResponse; export: ExportResponse; login: { ok: boolean };
}
export type ApiPayload = CreateProjectRequest | PatchProjectRequest | RefineRequest | GenerateRequest |
  RegenerateRequest | UploadRequest | RestoreRequest | ExportRequest | LoginRequest;
