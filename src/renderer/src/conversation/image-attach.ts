/**
 * Image-attachment helpers (#100) — the PURE, unit-tested core of composer image
 * support. No DOM, no IPC: this module only does string parsing + type checks.
 * `FileReader` (DOM) stays in the component; it hands us the resulting data URL.
 *
 * The wire contract (acp-capture §11) wants BARE base64 (no `data:` prefix) plus
 * the mime type; `parseDataUrl` splits a browser-produced `data:` URL into exactly
 * that shape.
 */

/** The image mime types the composer accepts (paste + picker). */
export const ACCEPTED_IMAGE_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
] as const

/** True when `type` is one of the accepted image mime types. */
export function isAcceptedImageType(type: string): boolean {
  return (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(type)
}

/**
 * Parse a `data:<mime>;base64,<payload>` URL into `{ mimeType, data }`, where
 * `data` is the BARE base64 (the `data:…;base64,` prefix stripped). Returns null
 * unless it's a base64 image data URL whose mime is one we accept.
 */
export function parseDataUrl(dataUrl: string): { data: string; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mimeType = match[1]
  const data = match[2]
  if (!isAcceptedImageType(mimeType)) return null
  if (data.length === 0) return null
  return { data, mimeType }
}
