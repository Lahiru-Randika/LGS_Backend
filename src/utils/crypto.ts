import crypto from 'node:crypto'

export const randomToken = (bytes = 48) => crypto.randomBytes(bytes).toString('base64url')
export const tokenHash = (token: string) => crypto.createHash('sha256').update(token).digest('hex')
export const sha256 = (buffer: Buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
export const requestId = () => crypto.randomUUID()
