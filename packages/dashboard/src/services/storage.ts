/// <reference types="vite/client" />

import COS from 'cos-js-sdk-v5'
import { useMemo } from 'react'
import { getApiBase } from './config'
import { tdFetch, type ApiContext } from './http'
import { useApiContext } from './api-context'

export interface BucketInfo {
  type: 'storage' | 'static'
  name: string
  label: string
  bucket: string
  region: string
  cdnDomain: string
  customDomain?: string
  isPublic: boolean
}

export interface FileInfo {
  key: string
  name: string
  size: number
  lastModified: string
  isDir: boolean
  fileId?: string // 云存储: cloud://envId/xxx
  publicUrl?: string // 静态托管: https://cdnDomain/xxx
}

export interface UploadOptions {
  /** 要上传的文件列表（来自 input.files） */
  files: File[]
  /** 目标存储桶信息 */
  bucket: BucketInfo
  /** 上传的目标前缀路径（如 "skills/"） */
  prefix?: string
  /** 每上传完一个文件的回调，返回当前已完成数 */
  onProgress?: (completed: number, total: number) => void
}

export interface UploadResult {
  successCount: number
  errors: string[]
}

export class StorageAPI {
  private base: string
  private ctx: ApiContext

  constructor(ctx: ApiContext, base = getApiBase()) {
    this.ctx = ctx
    this.base = base
  }

  async getBuckets(): Promise<BucketInfo[]> {
    const r = await tdFetch(this.ctx, `${this.base}/storage/buckets`)
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  }

  async listFiles(prefix = '', bucket: BucketInfo): Promise<FileInfo[]> {
    const p = new URLSearchParams({
      prefix,
      bucketType: bucket.type,
      cdnDomain: bucket.cdnDomain,
    })
    const r = await tdFetch(this.ctx, `${this.base}/storage/files?${p}`)
    if (!r.ok) throw new Error(await r.text())
    return r.json()
  }

  async getDownloadUrl(path: string): Promise<string> {
    const p = new URLSearchParams({ path })
    const r = await tdFetch(this.ctx, `${this.base}/storage/url?${p}`)
    if (!r.ok) throw new Error(await r.text())
    const data = await r.json()
    return data.url
  }

  async deleteFile(path: string, bucketType: 'storage' | 'static'): Promise<void> {
    const r = await tdFetch(this.ctx, `${this.base}/storage/files`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, bucketType }),
    })
    if (!r.ok) throw new Error(await r.text())
  }

  /**
   * 取后端为当前用户解析好的临时凭证（已限定到该用户的 envId / cos tag）。
   * 直接用此凭证走 cos-js-sdk 上传即可。后端不会暴露永久密钥。
   */
  async getUploadCredential(): Promise<{
    tmpSecretId: string
    tmpSecretKey: string
    sessionToken: string
    expiredTime: number
    envId: string
  }> {
    const url = `${this.base}/storage/upload-credential`

    const r = await tdFetch(this.ctx, url, {
      method: 'POST',
    })

    // 打印响应 headers
    const respHeaders: Record<string, string> = {}
    r.headers.forEach((v, k) => {
      respHeaders[k] = v
    })

    const data = await r.json()

    if (!r.ok || data.error) {
      const reqId = data.requestId ? ` (RequestId: ${data.requestId})` : ''
      const code = data.code ? ` [${data.code}]` : ''
      throw new Error(`${data.error || '签发失败'}${code}${reqId}`)
    }
    return data
  }

  /**
   * 上传文件列表到 COS 存储桶。
   * 同时兼容"上传文件"和"上传文件夹"两种场景：
   *   - 上传文件时 webkitRelativePath 为空，fallback 到 file.name
   *   - 上传文件夹时 webkitRelativePath 保留目录结构（如 "folder/sub/file.txt"）
   */
  async uploadFiles({ files, bucket, prefix = '', onProgress }: UploadOptions): Promise<UploadResult> {
    const cred = await this.getUploadCredential()
    const cos = new COS({
      getAuthorization: (_: any, callback: any) => {
        callback({
          TmpSecretId: cred.tmpSecretId,
          TmpSecretKey: cred.tmpSecretKey,
          SecurityToken: cred.sessionToken,
          ExpiredTime: cred.expiredTime,
        })
      },
    })

    let successCount = 0
    const errors: string[] = []

    for (const file of files) {
      const relPath = file.webkitRelativePath || file.name
      const key = (prefix + relPath).replace(/^\//, '')
      try {
        await new Promise<void>((resolve, reject) => {
          cos.putObject(
            {
              Bucket: bucket.bucket,
              Region: bucket.region,
              Key: key,
              Body: file,
            },
            (err: any, data: any) => {
              if (err) {
                reject(new Error(err.message || '上传失败'))
              } else {
                resolve()
              }
            },
          )
        })
        successCount++
      } catch {
        errors.push(relPath)
      }
      onProgress?.(successCount + errors.length, files.length)
    }

    return { successCount, errors }
  }
}

export function useStorageAPI(): StorageAPI {
  const ctx = useApiContext()
  return useMemo(() => new StorageAPI(ctx), [ctx])
}
