import { createManager, type CloudBaseCredentials } from './database.js'

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
  fileId?: string
  publicUrl?: string
}

export async function getBuckets(creds: CloudBaseCredentials): Promise<BucketInfo[]> {
  const manager = createManager(creds)
  const { EnvInfo } = await manager.env.getEnvInfo()
  const buckets: BucketInfo[] = []

  const storage = EnvInfo?.Storages?.[0]
  if (storage) {
    buckets.push({
      type: 'storage',
      name: storage.Bucket ?? '',
      label: '云存储',
      bucket: storage.Bucket ?? '',
      region: storage.Region ?? '',
      cdnDomain: (storage as any).CdnDomain || '',
      isPublic: false,
    })
  }

  try {
    const hostingInfo = await manager.hosting.getInfo()
    const hosting = hostingInfo?.[0]
    if (hosting) {
      buckets.push({
        type: 'static',
        name: hosting.Bucket || 'static',
        label: '静态托管',
        bucket: hosting.Bucket || '',
        region: (hosting as any).Regoin || storage?.Region || 'ap-shanghai',
        cdnDomain: hosting.CdnDomain || '',
        isPublic: true,
      })
    }
  } catch {
    const staticStore = (EnvInfo as any)?.StaticStorages?.[0]
    if (staticStore) {
      buckets.push({
        type: 'static',
        name: staticStore.Bucket || 'static',
        label: '静态托管',
        bucket: staticStore.Bucket || '',
        region: staticStore.Region || storage?.Region || 'ap-shanghai',
        cdnDomain: staticStore.CdnDomain || '',
        isPublic: true,
      })
    }
  }

  return buckets
}

export async function listStorageFiles(creds: CloudBaseCredentials, prefix: string = ''): Promise<FileInfo[]> {
  const manager = createManager(creds)
  const files = await manager.storage.walkCloudDir(prefix)

  const fileMap = new Map<string, FileInfo>()

  for (const f of files) {
    const key = f.Key
    if (!key) continue

    const rel = prefix ? key.slice(prefix.length) : key
    if (!rel) continue

    const slashIdx = rel.indexOf('/')
    if (slashIdx !== -1 && slashIdx < rel.length - 1) {
      const dirName = rel.slice(0, slashIdx + 1)
      const dirKey = prefix + dirName
      if (!fileMap.has(dirKey)) {
        fileMap.set(dirKey, {
          key: dirKey,
          name: dirName.replace(/\/$/, ''),
          size: 0,
          lastModified: f.LastModified,
          isDir: true,
        })
      }
    } else {
      fileMap.set(key, {
        key,
        name: rel.replace(/\/$/, ''),
        size: Number(f.Size) || 0,
        lastModified: f.LastModified,
        isDir: false,
        fileId: `cloud://${creds.envId}/${key}`,
      })
    }
  }

  return Array.from(fileMap.values())
}

export async function listHostingFiles(
  creds: CloudBaseCredentials,
  prefix: string = '',
  cdnDomain: string = '',
): Promise<FileInfo[]> {
  const manager = createManager(creds)
  const result = await manager.hosting.listFiles()
  const fileMap = new Map<string, FileInfo>()

  for (const f of result || []) {
    const key: string = (f as any).Key || ''
    if (!key) continue
    if (prefix && !key.startsWith(prefix)) continue

    const rel = prefix ? key.slice(prefix.length) : key
    if (!rel) continue

    const slashIdx = rel.indexOf('/')
    if (slashIdx !== -1 && slashIdx < rel.length - 1) {
      const dirName = rel.slice(0, slashIdx + 1)
      const dirKey = prefix + dirName
      if (!fileMap.has(dirKey)) {
        fileMap.set(dirKey, {
          key: dirKey,
          name: dirName.replace(/\/$/, ''),
          size: 0,
          lastModified: (f as any).LastModified || '',
          isDir: true,
        })
      }
    } else {
      const publicUrl = cdnDomain ? `https://${cdnDomain}/${key}` : ''
      fileMap.set(key, {
        key,
        name: rel.replace(/\/$/, ''),
        size: Number((f as any).Size) || 0,
        lastModified: (f as any).LastModified || '',
        isDir: false,
        publicUrl,
      })
    }
  }

  return Array.from(fileMap.values())
}

export async function getDownloadUrl(creds: CloudBaseCredentials, cloudPath: string): Promise<string> {
  const manager = createManager(creds)
  const result = await manager.storage.getTemporaryUrl([{ cloudPath, maxAge: 3600 }])
  return result?.[0]?.url || ''
}

export async function deleteFile(creds: CloudBaseCredentials, cloudPath: string): Promise<void> {
  const manager = createManager(creds)

  // If cloudPath ends with '/', it's a directory — need to list all files under it then delete
  if (cloudPath.endsWith('/')) {
    const files = await manager.storage.walkCloudDir(cloudPath)
    const keys = files.map((f: any) => f.Key).filter(Boolean) as string[]
    if (keys.length > 0) {
      await manager.storage.deleteFile(keys)
    }
  } else {
    await manager.storage.deleteFile([cloudPath])
  }
}

export async function deleteHostingFile(creds: CloudBaseCredentials, cloudPath: string): Promise<void> {
  const manager = createManager(creds)
  await manager.hosting.deleteFiles({ cloudPath, isDir: false })
}
