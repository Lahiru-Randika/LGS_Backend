import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import multer from 'multer'
import { env } from '../config/env'
import { badRequest } from '../utils/errors'
import { sha256 } from '../utils/crypto'

export const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_BYTES, files: env.MAX_UPLOAD_FILES },
})

function sniff(buffer: Buffer): { mime: string; ext: string } | null {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a]))) return { mime: 'image/png', ext: 'png' }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString('ascii') === '%PDF') return { mime: 'application/pdf', ext: 'pdf' }
  return null
}

export interface PersistedUpload {
  storageKey: string
  originalFilename: string
  mimeType: string
  fileSize: number
  sha256: string
}

export async function persistUploads(files: Express.Multer.File[] = []): Promise<PersistedUpload[]> {
  const now = new Date()
  const year = String(now.getUTCFullYear())
  const month = String(now.getUTCMonth() + 1).padStart(2, '0')
  const directory = path.resolve(env.UPLOAD_DIR, year, month)
  await fs.mkdir(directory, { recursive: true })

  const saved: PersistedUpload[] = []
  try {
    for (const file of files) {
      const detected = sniff(file.buffer)
      if (!detected) throw badRequest('Only genuine PNG, JPEG, and PDF files are accepted.')
      const filename = `${crypto.randomUUID()}.${detected.ext}`
      const fullPath = path.join(directory, filename)
      await fs.writeFile(fullPath, file.buffer, { flag: 'wx', mode: 0o600 })
      saved.push({
        storageKey: path.join(year, month, filename).replaceAll('\\', '/'),
        originalFilename: path.basename(file.originalname).slice(0, 255),
        mimeType: detected.mime,
        fileSize: file.size,
        sha256: sha256(file.buffer),
      })
    }
    return saved
  } catch (error) {
    await Promise.all(saved.map((file) => fs.rm(path.resolve(env.UPLOAD_DIR, file.storageKey), { force: true })))
    throw error
  }
}

export async function removePersistedUploads(files: PersistedUpload[]) {
  await Promise.all(files.map((file) => fs.rm(path.resolve(env.UPLOAD_DIR, file.storageKey), { force: true })))
}
