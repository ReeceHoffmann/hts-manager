import { realpathSync, statSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { z } from 'zod'

function emptyStringToUndefined(value: unknown): unknown {
  return typeof value === 'string' && value.trim() === '' ? undefined : value
}

const optionalString = z.preprocess(
  emptyStringToUndefined,
  z.string().min(1).optional(),
)

function booleanFromEnv(defaultValue: boolean) {
  return z.preprocess(
    emptyStringToUndefined,
    z
      .stringbool({ truthy: ['true'], falsy: ['false'] })
      .default(defaultValue),
  )
}

const optionalNonnegativeInteger = z.preprocess(
  emptyStringToUndefined,
  z.coerce.number().int().nonnegative().optional(),
)

const environmentSchema = z
  .object({
    HTSM_PIN: optionalString,
    HTSM_SESSION_SECRET: optionalString,
    HTSM_SECURE: booleanFromEnv(true),
    HTSM_DB_PATH: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1).default('./hts-manager.db'),
    ),
    HTSM_SCAN_PATH: optionalString,
    HTSM_FASTQ_SYMLINK_PATH: optionalString,
    HTSM_TRANSFER_SOURCE_PATH: optionalString,
    HTSM_TRANSFER_REMOVE_AFTER_DAYS: optionalNonnegativeInteger,
    VT_UPLOAD_URL: z.preprocess(
      emptyStringToUndefined,
      z.url().default('https://preview.virtool.ca/api/uploads'),
    ),
    VT_UPLOAD_FILE_TYPE: z.preprocess(
      emptyStringToUndefined,
      z.string().min(1).default('reads'),
    ),
    VT_UPLOAD_USER_HANDLE: optionalString,
    VT_UPLOAD_API_KEY: optionalString,
  })
  .superRefine((env, ctx) => {
    const sourcePath = env.HTSM_TRANSFER_SOURCE_PATH
    const destinationPath = env.HTSM_SCAN_PATH
    const fastqSymlinkPath = env.HTSM_FASTQ_SYMLINK_PATH

    if (fastqSymlinkPath) {
      if (!isAbsolute(fastqSymlinkPath)) {
        ctx.addIssue({
          code: 'custom',
          path: ['HTSM_FASTQ_SYMLINK_PATH'],
          message: 'HTSM_FASTQ_SYMLINK_PATH must be absolute',
        })
      }

      if (!destinationPath) {
        ctx.addIssue({
          code: 'custom',
          path: ['HTSM_SCAN_PATH'],
          message:
            'HTSM_SCAN_PATH is required when HTSM_FASTQ_SYMLINK_PATH is set',
        })
      } else {
        const resolvedScanPath = validateDirectory(
          'HTSM_SCAN_PATH',
          destinationPath,
          ctx,
        )
        const resolvedFastqSymlinkPath = resolve(fastqSymlinkPath)

        if (
          resolvedScanPath &&
          (resolvedScanPath === resolvedFastqSymlinkPath ||
            isNestedPath(resolvedScanPath, resolvedFastqSymlinkPath) ||
            isNestedPath(resolvedFastqSymlinkPath, resolvedScanPath))
        ) {
          ctx.addIssue({
            code: 'custom',
            path: ['HTSM_FASTQ_SYMLINK_PATH'],
            message:
              'HTSM_FASTQ_SYMLINK_PATH and HTSM_SCAN_PATH must be distinct and not nested',
          })
        }
      }
    }

    if (!sourcePath) {
      if (env.HTSM_TRANSFER_REMOVE_AFTER_DAYS !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['HTSM_TRANSFER_REMOVE_AFTER_DAYS'],
          message:
            'HTSM_TRANSFER_REMOVE_AFTER_DAYS requires HTSM_TRANSFER_SOURCE_PATH',
        })
      }
      return
    }

    if (!isAbsolute(sourcePath)) {
      ctx.addIssue({
        code: 'custom',
        path: ['HTSM_TRANSFER_SOURCE_PATH'],
        message: 'HTSM_TRANSFER_SOURCE_PATH must be absolute',
      })
    }

    if (!destinationPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['HTSM_SCAN_PATH'],
        message: 'HTSM_SCAN_PATH is required when transfer source is set',
      })
      return
    }

    const resolvedSourcePath = isAbsolute(sourcePath)
      ? validateDirectory('HTSM_TRANSFER_SOURCE_PATH', sourcePath, ctx)
      : undefined
    const resolvedDestinationPath = validateDirectory(
      'HTSM_SCAN_PATH',
      destinationPath,
      ctx,
    )

    if (!resolvedSourcePath || !resolvedDestinationPath) return

    if (resolvedSourcePath === resolvedDestinationPath) {
      ctx.addIssue({
        code: 'custom',
        path: ['HTSM_TRANSFER_SOURCE_PATH'],
        message:
          'HTSM_TRANSFER_SOURCE_PATH and HTSM_SCAN_PATH must be distinct',
      })
    } else if (
      isNestedPath(resolvedSourcePath, resolvedDestinationPath) ||
      isNestedPath(resolvedDestinationPath, resolvedSourcePath)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['HTSM_TRANSFER_SOURCE_PATH'],
        message:
          'HTSM_TRANSFER_SOURCE_PATH and HTSM_SCAN_PATH must not be nested',
      })
    }
  })
  .transform((env) => {
    const sourcePath = env.HTSM_TRANSFER_SOURCE_PATH
    const destinationPath = env.HTSM_SCAN_PATH
    const fastqSymlinkPath = env.HTSM_FASTQ_SYMLINK_PATH

    return {
      auth: {
        pin: env.HTSM_PIN,
        sessionSecret: env.HTSM_SESSION_SECRET,
        secure: env.HTSM_SECURE,
      },
      dbPath: env.HTSM_DB_PATH,
      scanPath: destinationPath,
      fastqLinks: fastqSymlinkPath
        ? {
            enabled: true as const,
            sourcePath: realpathSync(destinationPath!),
            destinationPath: resolve(fastqSymlinkPath),
          }
        : {
            enabled: false as const,
            sourcePath: null,
            destinationPath: null,
          },
      transfer: sourcePath
        ? {
            enabled: true,
            sourcePath: realpathSync(sourcePath),
            destinationPath: realpathSync(destinationPath!),
            removeAfterDays: env.HTSM_TRANSFER_REMOVE_AFTER_DAYS ?? null,
          }
        : {
            enabled: false,
            sourcePath: null,
            destinationPath: destinationPath ?? null,
            removeAfterDays: null,
          },
      upload: {
        url: env.VT_UPLOAD_URL,
        type: env.VT_UPLOAD_FILE_TYPE,
        userHandle: env.VT_UPLOAD_USER_HANDLE,
        apiKey: env.VT_UPLOAD_API_KEY,
      },
    }
  })

export type Config = z.output<typeof environmentSchema>
export type FastqLinkConfig = Config['fastqLinks']
export type TransferConfig = Config['transfer']

/** Parse raw environment strings into the application's typed configuration. */
export function readConfig(env: NodeJS.ProcessEnv): Config {
  return environmentSchema.parse(env)
}

let config: Config | undefined

/** Return the process configuration, parsing it once on first use. */
export function getConfig(): Config {
  config ??= readConfig(process.env)
  return config
}

function validateDirectory(
  name: string,
  path: string,
  ctx: z.RefinementCtx,
): string | undefined {
  let stat
  try {
    stat = statSync(path)
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    ctx.addIssue({
      code: 'custom',
      path: [name],
      message: `${name} must exist and be a directory: ${detail}`,
    })
    return undefined
  }

  if (!stat.isDirectory()) {
    ctx.addIssue({
      code: 'custom',
      path: [name],
      message: `${name} must be a directory`,
    })
    return undefined
  }

  return realpathSync(path)
}

function isNestedPath(parent: string, child: string): boolean {
  const result = relative(parent, child)
  return result !== '' && !result.startsWith('..') && !isAbsolute(result)
}

export function getAuthConfig(): {
  pin: string
  sessionSecret: string
  secure: boolean
} {
  const { pin, sessionSecret, secure } = getConfig().auth
  if (!pin) throw new Error('HTSM_PIN is not set')
  if (!sessionSecret) throw new Error('HTSM_SESSION_SECRET is not set')
  return { pin, sessionSecret, secure }
}

export function getUploadConfig(): {
  url: string
  type: string
  userHandle: string
  apiKey: string
} {
  const { url, type, userHandle, apiKey } = getConfig().upload
  if (!userHandle || !apiKey) {
    throw new Error(
      'VT_UPLOAD_USER_HANDLE and VT_UPLOAD_API_KEY must be set to upload',
    )
  }
  return { url, type, userHandle, apiKey }
}
