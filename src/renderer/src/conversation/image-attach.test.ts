import { describe, expect, it } from 'vitest'
import { ACCEPTED_IMAGE_TYPES, isAcceptedImageType, parseDataUrl } from './image-attach'

describe('isAcceptedImageType', () => {
  it('accepts the four supported image mime types', () => {
    for (const type of ACCEPTED_IMAGE_TYPES) {
      expect(isAcceptedImageType(type)).toBe(true)
    }
  })

  it('rejects non-image and unsupported image mime types', () => {
    expect(isAcceptedImageType('text/plain')).toBe(false)
    expect(isAcceptedImageType('image/svg+xml')).toBe(false)
    expect(isAcceptedImageType('image/tiff')).toBe(false)
    expect(isAcceptedImageType('')).toBe(false)
  })
})

describe('parseDataUrl', () => {
  it('parses a valid png data URL into bare base64 + mime type', () => {
    expect(parseDataUrl('data:image/png;base64,aGVsbG8=')).toEqual({
      data: 'aGVsbG8=',
      mimeType: 'image/png',
    })
  })

  it('parses a valid jpeg data URL', () => {
    expect(parseDataUrl('data:image/jpeg;base64,/9j/4AAQ')).toEqual({
      data: '/9j/4AAQ',
      mimeType: 'image/jpeg',
    })
  })

  it('returns null for non-data-url input', () => {
    expect(parseDataUrl('https://example.com/a.png')).toBeNull()
    expect(parseDataUrl('aGVsbG8=')).toBeNull()
    expect(parseDataUrl('')).toBeNull()
  })

  it('returns null for a non-base64 data url', () => {
    expect(parseDataUrl('data:image/png,rawtext')).toBeNull()
    expect(parseDataUrl('data:image/png;charset=utf-8,hello')).toBeNull()
  })

  it('returns null for an unknown / unsupported mime type', () => {
    expect(parseDataUrl('data:image/svg+xml;base64,PHN2Zz4=')).toBeNull()
    expect(parseDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull()
  })

  it('returns null for an empty base64 payload', () => {
    expect(parseDataUrl('data:image/png;base64,')).toBeNull()
  })
})
