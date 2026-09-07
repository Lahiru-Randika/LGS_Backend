import {
  badRequest,
} from './errors'

export function routeParam(
  value:
    string |
    string[] |
    undefined,

  name:
    string,
): string {
  const resolved =
    Array.isArray(value)
      ? value[0]
      : value

  if (!resolved) {
    throw badRequest(
      `Missing route parameter: ${name}.`,
    )
  }

  return resolved
}