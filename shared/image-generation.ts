export const DEFAULT_IMAGE_MODEL = 'gpt-image-2.5-flare'
export const IMAGE_QUALITY = 'low' as const
export const IMAGE_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const
export type ImageSize = typeof IMAGE_SIZES[number]

/** Only a human-confirmed request reaches the image service. Board AI proposes it separately. */
export interface ImageGenerationRequest {
  requestId: string
  prompt: string
  originalPrompt?: string
  size: ImageSize
  confirmed: true
}

export interface GeneratedImage {
  dataUrl: string
  width: number
  height: number
}

export interface ImageTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

export interface ImageGenerationJob {
  requestId: string
  status: 'queued' | 'generating' | 'completed' | 'failed'
  createdAt: number
  updatedAt: number
  expiresAt?: number
  model: string
  quality: typeof IMAGE_QUALITY
  size: ImageSize
  result?: GeneratedImage
  usage?: ImageTokenUsage
  error?: { code: string; message: string }
}

export interface ImageGenerationUsage {
  /** Accepted requests, including failures: a timeout does not prove no charge occurred. */
  reserved: number
  limit: number
  active: number
  queued: number
}
