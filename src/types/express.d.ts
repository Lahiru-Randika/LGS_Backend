import 'express'

declare global {
  namespace Express {
    interface AuthUser {
      id: number
      publicId: string
      email: string
      displayName: string
      role: string
      departmentId: number | null
      wardId: number | null
      permissions: string[]
    }

    interface Request {
      authUser?: AuthUser
      authSessionHash?: string
      requestId?: string
    }
  }
}

export {}
