import * as fs from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import * as path from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import CloudBase from '@cloudbase/node-sdk'
import { loadConfig } from '../config/store.js'
import type {
  CodeBuddyMessage,
  CodeBuddyContentBlock,
  UnifiedMessageRecord,
  UnifiedMessagePart,
  StreamEvent,
} from '@coder/shared'
import { AGENT_ID } from '@coder/shared'

// ─── Constants ────────────────────────────────────────────────────────────

const COLLECTION_NAME = 'vibe_agent_messages'
const STREAM_EVENTS_COLLECTION = 'vibe_agent_stream_events'

// ─── Helper Functions ──────────────────────────────────────────────────────

function getHomeDir(): string {
  return process.env.HOME || process.env.USERPROFILE || ''
}

function getProjectHash(cwd: string): string {
  return cwd
    .replace(/[/\\:]/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .replace(/-+/g, '-')
}

function getLocalMessageFilePath(sessionId: string, cwd: string): string {
  // Resolve symlinks (e.g. macOS /tmp → /private/tmp) to match CLI's realpath behavior
  let resolvedCwd = cwd
  try {
    resolvedCwd = realpathSync(cwd)
  } catch {
    // cwd may not exist yet, use as-is
  }
  const projectDirName = getProjectHash(resolvedCwd)
  const homeDir = getHomeDir()
  const coderProjectsDir = path.join(homeDir, '.codebuddy', 'projects')
  return path.join(coderProjectsDir, projectDirName, `${sessionId}.jsonl`)
}

// ─── Persistence Service ───────────────────────────────────────────────────

/**
 * 消息持久化服务
 *
 * 使用 CloudBase 文档数据库存储消息记录
 */
export class PersistenceService {
  /**
   * 使用【支撑身份】初始化 CloudBase SDK
   * 凭证来源：系统环境变量（永久密钥），用于操作支撑环境的数据库
   * 注意：DB 记录中的 envId 字段是【用户环境 ID】，由 caller 传入，用于数据隔离
   */
  private async getCloudBaseApp(): Promise<ReturnType<typeof CloudBase.init>> {
    const config = loadConfig()
    const envId = process.env.TCB_ENV_ID || config.cloudbase?.envId
    const region = process.env.TCB_REGION || config.cloudbase?.region || 'ap-shanghai'

    if (!envId) {
      throw new Error('缺少支撑环境配置，请设置 TCB_ENV_ID 环境变量')
    }

    const secretId = process.env.TCB_SECRET_ID
    const secretKey = process.env.TCB_SECRET_KEY
    const token = process.env.TCB_TOKEN || undefined

    if (!secretId || !secretKey) {
      throw new Error('缺少支撑身份密钥，请设置 TCB_SECRET_ID 和 TCB_SECRET_KEY 环境变量')
    }

    return CloudBase.init({
      env: envId,
      region,
      secretId,
      secretKey,
      ...(token ? { sessionToken: token } : {}),
    })
  }

  private collectionEnsured = false
  private streamCollectionEnsured = false

  private async getCollection() {
    const app = await this.getCloudBaseApp()
    const db = app.database()

    // 首次访问时确保集合存在
    if (!this.collectionEnsured) {
      try {
        await db.createCollection(COLLECTION_NAME)
      } catch {
        // 集合已存在会抛错，忽略
      }
      this.collectionEnsured = true
    }

    return db.collection(COLLECTION_NAME)
  }

  private async getStreamEventsCollection() {
    const app = await this.getCloudBaseApp()
    const db = app.database()

    if (!this.streamCollectionEnsured) {
      try {
        await db.createCollection(STREAM_EVENTS_COLLECTION)
      } catch {
        // Collection already exists
      }
      this.streamCollectionEnsured = true
    }

    return db.collection(STREAM_EVENTS_COLLECTION)
  }

  // ========== Stream Event Operations ==========

  async appendStreamEvents(events: StreamEvent[]): Promise<void> {
    if (events.length === 0) return
    try {
      const collection = await this.getStreamEventsCollection()
      for (const event of events) {
        await collection.add(event)
      }
    } catch (error) {
      console.error('Failed to append stream events:', error)
    }
  }

  async getStreamEvents(
    conversationId: string,
    turnId: string,
    afterSeq: number = -1,
    limit: number = 500,
  ): Promise<StreamEvent[]> {
    try {
      const collection = await this.getStreamEventsCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      const { data } = await collection
        .where({
          conversationId: _.eq(conversationId),
          turnId: _.eq(turnId),
          seq: _.gt(afterSeq),
        })
        .orderBy('seq', 'asc')
        .limit(limit)
        .get()

      return data as StreamEvent[]
    } catch (error) {
      console.error('Failed to get stream events:', error)
      return []
    }
  }

  async cleanupStreamEvents(conversationId: string, turnId: string): Promise<void> {
    try {
      const collection = await this.getStreamEventsCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      await collection
        .where({
          conversationId: _.eq(conversationId),
          turnId: _.eq(turnId),
        })
        .remove()
    } catch {
      // Non-critical, stale events don't affect correctness
    }
  }

  // ========== Message Conversion ==========

  private transformDBMessagesToCodeBuddyMessages(
    records: UnifiedMessageRecord[],
    sessionId: string,
  ): CodeBuddyMessage[] {
    const messages: CodeBuddyMessage[] = []

    for (const record of records) {
      const timestamp = record.createTime || Date.now()

      if (record.role === 'user') {
        this.restoreUserRecord(record, timestamp, sessionId, messages)
      } else if (record.role === 'assistant') {
        this.restoreAssistantRecord(record, timestamp, sessionId, messages)
      }
    }

    this.fixSelfReferencingParentIds(messages)

    return messages
  }

  private fixSelfReferencingParentIds(messages: CodeBuddyMessage[]): void {
    const idSet = new Set<string>()
    const idTypeMap = new Map<string, string>()

    for (const msg of messages) {
      if (msg.id) {
        idSet.add(msg.id)
        idTypeMap.set(msg.id, msg.type)
      }
    }

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      let needsFix = false

      if (msg.parentId && msg.parentId === msg.id) {
        needsFix = true
      } else if (msg.parentId) {
        const parentType = idTypeMap.get(msg.parentId)
        if (!parentType || parentType === 'file-history-snapshot') {
          needsFix = true
        }
      } else if (msg.type === 'function_call' || msg.type === 'function_call_result') {
        needsFix = true
      }

      if (needsFix) {
        if (i === 0) {
          msg.parentId = undefined
        } else {
          for (let j = i - 1; j >= 0; j--) {
            const prevMsg = messages[j]
            if (prevMsg.id && prevMsg.type !== 'file-history-snapshot' && prevMsg.id !== prevMsg.parentId) {
              msg.parentId = prevMsg.id
              break
            }
          }
        }
      }
    }
  }

  private restoreUserRecord(
    record: UnifiedMessageRecord,
    _timestamp: number,
    _sessionId: string,
    messages: CodeBuddyMessage[],
  ): void {
    for (const part of record.parts || []) {
      const msg = this.restorePartToMessage(part)
      if (msg) messages.push(msg)
    }
  }

  private restoreAssistantRecord(
    record: UnifiedMessageRecord,
    _timestamp: number,
    _sessionId: string,
    messages: CodeBuddyMessage[],
  ): void {
    const pendingMessages: CodeBuddyMessage[] = []
    let messagePartMsg: CodeBuddyMessage | null = null

    for (const part of record.parts || []) {
      if (part.contentType === 'text') {
        messagePartMsg = this.restorePartToMessage(part)
      } else {
        const msg = this.restorePartToMessage(part)
        if (msg) pendingMessages.push(msg)
      }
    }

    messages.push(...pendingMessages)
    if (messagePartMsg) messages.push(messagePartMsg)
  }

  private restorePartToMessage(part: UnifiedMessagePart): CodeBuddyMessage | null {
    const metadata = part.metadata as Record<string, unknown> | undefined
    if (!metadata) return null

    if (part.contentType === 'text') {
      const { contentBlocks, ...rest } = metadata as { contentBlocks?: unknown }
      if (contentBlocks) {
        return { ...rest, content: contentBlocks as CodeBuddyContentBlock[] } as CodeBuddyMessage
      }
      const blockType = (rest as any).role === 'assistant' ? 'output_text' : 'input_text'
      return {
        ...rest,
        content: [{ type: blockType, text: part.content || '' }],
      } as CodeBuddyMessage
    }

    if (part.contentType === 'tool_call') {
      const { toolCallName, ...rest } = metadata as { toolCallName?: string }
      return {
        ...rest,
        name: toolCallName,
        callId: part.toolCallId,
        arguments: part.content,
      } as CodeBuddyMessage
    }

    if (part.contentType === 'tool_result') {
      let output: string | Record<string, unknown> = part.content || ''
      try {
        const parsed = JSON.parse(output)
        if (typeof parsed === 'object' && parsed !== null) output = parsed
      } catch {
        // Keep as string
      }
      return { ...metadata, callId: part.toolCallId, output } as CodeBuddyMessage
    }

    if (part.contentType === 'reasoning') {
      return {
        ...metadata,
        type: 'reasoning',
      } as unknown as CodeBuddyMessage
    }

    return { ...metadata } as unknown as CodeBuddyMessage
  }

  // ========== Local File Operations ==========

  private async writeLocalMessageFile(filePath: string, messages: CodeBuddyMessage[]): Promise<void> {
    const dir = path.dirname(filePath)
    await fs.mkdir(dir, { recursive: true })
    const content = messages.map((m) => JSON.stringify(m)).join('\n')
    await fs.writeFile(filePath, content + '\n', 'utf-8')
  }

  private async readLocalMessageFile(filePath: string): Promise<CodeBuddyMessage[]> {
    try {
      const content = await fs.readFile(filePath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)
      return lines.map((line) => JSON.parse(line))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return []
      }
      throw error
    }
  }

  private async cleanupLocalFile(filePath: string): Promise<void> {
    try {
      await fs.unlink(filePath)
    } catch {
      // Ignore errors
    }
  }

  // ========== Database Operations ==========

  async loadDBMessages(
    conversationId: string,
    envId: string,
    userId: string,
    limit = 20,
  ): Promise<UnifiedMessageRecord[]> {
    try {
      const collection = await this.getCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      const { data } = await collection
        .where({
          conversationId: _.eq(conversationId),
          envId: _.eq(envId),
          userId: _.eq(userId),
          agentId: _.eq(AGENT_ID),
        })
        .orderBy('createTime', 'desc')
        .limit(limit)
        .get()

      const sorted = (data as any[]).reverse()

      // 保证 QA 成对：从后往前找到第一条 user 消息，丢弃它之前的 assistant
      const firstUserIdx = sorted.findIndex((r) => r.role === 'user')
      const valid = firstUserIdx >= 0 ? sorted.slice(firstUserIdx) : sorted

      return valid.map((r) => ({
        recordId: r.recordId,
        conversationId: r.conversationId,
        replyTo: r.replyTo,
        role: r.role,
        status: r.status,
        envId: r.envId,
        userId: r.userId,
        agentId: r.agentId,
        content: r.content,
        parts: r.parts || [],
        createTime: r.createTime || Date.now(),
      }))
    } catch {
      return []
    }
  }

  private async saveRecordToDB(
    record: Omit<UnifiedMessageRecord, 'createTime'> & { createTime?: number },
  ): Promise<UnifiedMessageRecord> {
    const collection = await this.getCollection()
    const now = Date.now()

    const doc = {
      ...record,
      createTime: record.createTime || now,
      updateTime: now,
    }

    await collection.add(doc)

    return {
      ...doc,
      createTime: doc.createTime,
    } as UnifiedMessageRecord
  }

  async updateRecordStatus(recordId: string, status: UnifiedMessageRecord['status']): Promise<void> {
    const collection = await this.getCollection()
    const app = await this.getCloudBaseApp()
    const _ = app.database().command

    await collection.where({ recordId: _.eq(recordId) }).update({ status, updateTime: Date.now() })
  }

  private async appendPartsToRecord(recordId: string, parts: UnifiedMessagePart[]): Promise<void> {
    if (parts.length === 0) return

    const collection = await this.getCollection()
    const app = await this.getCloudBaseApp()
    const _ = app.database().command

    const { data } = await collection.where({ recordId: _.eq(recordId) }).get()
    if (!data || data.length === 0) return

    const existingRecord = data[0] as any
    const existingParts = existingRecord.parts || []
    const updatedParts = [...existingParts, ...parts]

    await collection.where({ recordId: _.eq(recordId) }).update({ parts: updatedParts, updateTime: Date.now() })
  }

  private async replacePartsInRecord(recordId: string, parts: UnifiedMessagePart[]): Promise<void> {
    const collection = await this.getCollection()
    const app = await this.getCloudBaseApp()
    const _ = app.database().command

    await collection.where({ recordId: _.eq(recordId) }).update({ parts, updateTime: Date.now() })
  }

  // ========== Message Grouping ==========

  private groupMessages(messages: CodeBuddyMessage[]): CodeBuddyMessage[][] {
    const groups: CodeBuddyMessage[][] = []
    let currentGroup: CodeBuddyMessage[] = []

    for (const msg of messages) {
      if (msg.type !== 'message') {
        currentGroup.push(msg)
        continue
      }

      const isRealUserInput = msg.role === 'user' && this.isUserTextMessage(msg)
      if (isRealUserInput) {
        if (currentGroup.length > 0) {
          groups.push(currentGroup)
          currentGroup = []
        }
        groups.push([msg])
      } else {
        currentGroup.push(msg)
      }
    }

    if (currentGroup.length > 0) {
      groups.push(currentGroup)
    }

    return groups
  }

  private isUserTextMessage(msg: CodeBuddyMessage): boolean {
    if (!msg.content || msg.content.length === 0) return false
    const hasInputText = msg.content.some((b) => b.type === 'input_text')
    const onlyToolResult = msg.content.every((b) => b.type === 'tool_result')
    return hasInputText && !onlyToolResult
  }

  private isToolResultMessage(msg: CodeBuddyMessage): boolean {
    if (msg.type === 'file-history-snapshot') return false
    if (!msg.content || msg.content.length === 0) return false
    return msg.content.every((b) => b.type === 'tool_result')
  }

  private extractPartsFromMessage(msg: CodeBuddyMessage): UnifiedMessagePart[] {
    if (msg.type === 'message') {
      const { content: contentBlocks, ...messageMeta } = msg
      const blocks = contentBlocks || []

      const textBlocks = blocks.filter((b) => b.type === 'input_text' || b.type === 'output_text')
      const plainText = textBlocks.map((b) => b.text || '').join('\n')

      const isSimple =
        blocks.length === 1 &&
        textBlocks.length === 1 &&
        Object.keys(blocks[0]).filter((k) => k !== 'type' && k !== 'text').length === 0

      const metadata: Record<string, unknown> = { ...messageMeta }
      if (!isSimple) {
        metadata.contentBlocks = blocks
      }

      return [
        {
          partId: uuidv4(),
          contentType: 'text',
          content: plainText,
          metadata,
        },
      ]
    }

    if (msg.type === 'function_call') {
      const { arguments: _args, callId: _callId, name: _name, ...rest } = msg
      return [
        {
          partId: uuidv4(),
          contentType: 'tool_call',
          toolCallId: _callId,
          content: _args,
          metadata: { ...rest, toolCallName: _name } as Record<string, unknown>,
        },
      ]
    }

    if (msg.type === 'function_call_result') {
      const { output: _output, callId: _callId, ...rest } = msg
      return [
        {
          partId: uuidv4(),
          contentType: 'tool_result',
          toolCallId: _callId,
          content: typeof _output === 'string' ? _output : JSON.stringify(_output),
          metadata: rest as Record<string, unknown>,
        },
      ]
    }

    if (msg.type === 'reasoning') {
      const rawContent = msg.rawContent || []
      const reasoningText = rawContent
        .filter((block) => block.type === 'reasoning_text' && block.text)
        .map((block) => block.text || '')
        .join('')

      return [
        {
          partId: uuidv4(),
          contentType: 'reasoning',
          content: reasoningText,
          metadata: { ...msg } as Record<string, unknown>,
        },
      ]
    }

    return [
      {
        partId: uuidv4(),
        contentType: 'raw',
        metadata: { ...msg } as Record<string, unknown>,
      },
    ]
  }

  // ========== Public API ==========

  async restoreMessages(
    conversationId: string,
    envId: string,
    userId: string,
    cwd: string,
  ): Promise<{
    messages: CodeBuddyMessage[]
    lastRecordId: string | null
    lastAssistantRecordId: string | null
  }> {
    try {
      const dbRecords = await this.loadDBMessages(conversationId, envId, userId)
      const lastRecordId = dbRecords.length > 0 ? dbRecords[dbRecords.length - 1].recordId : null
      const lastAssistantRecord = [...dbRecords].reverse().find((r) => r.role === 'assistant')
      const lastAssistantRecordId = lastAssistantRecord?.recordId ?? null

      if (dbRecords.length === 0) {
        return { messages: [], lastRecordId: null, lastAssistantRecordId: null }
      }

      const messages = this.transformDBMessagesToCodeBuddyMessages(dbRecords, conversationId)

      const localFilePath = getLocalMessageFilePath(conversationId, cwd)
      await this.writeLocalMessageFile(localFilePath, messages)

      // DEBUG: copy JSONL after restore for comparison
      try {
        const debugDir = path.resolve(cwd, 'debug-jsonl')
        await fs.mkdir(debugDir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const debugPath = path.join(debugDir, `${conversationId}_after-restore_${timestamp}.jsonl`)
        await fs.copyFile(localFilePath, debugPath)
        console.error(`[DEBUG] Copied JSONL after restore to: ${debugPath}`)
      } catch {
        // debug copy failed, ignore
      }

      return { messages, lastRecordId, lastAssistantRecordId }
    } catch {
      return { messages: [], lastRecordId: null, lastAssistantRecordId: null }
    }
  }

  async syncMessages(
    conversationId: string,
    envId: string,
    userId: string,
    historicalMessages: CodeBuddyMessage[],
    lastRecordId: string | null,
    cwd: string,
    assistantRecordId?: string,
    isResumeFromInterrupt?: boolean,
    preSavedUserRecordId?: string | null,
  ): Promise<void> {
    const localFilePath = getLocalMessageFilePath(conversationId, cwd)

    try {
      const allMessages = await this.readLocalMessageFile(localFilePath)
      if (allMessages.length === 0) return

      const historicalIds = new Set(historicalMessages.map((m) => m.id))
      let newMessages = allMessages.filter((m) => !historicalIds.has(m.id))

      // Deduplicate function_calls
      const map: Record<string, boolean> = {}
      newMessages = newMessages.reduce((list, item) => {
        if (item.type === 'function_call') {
          if (!map[item.callId || '']) {
            map[item.callId || ''] = true
            list.push(item)
          }
        } else {
          list.push(item)
        }
        return list
      }, [] as CodeBuddyMessage[])

      // Resume: remove first fake user message
      if (isResumeFromInterrupt && newMessages.length > 0) {
        const firstUserMsgIndex = newMessages.findIndex((m) => m.type === 'message' && m.role === 'user')
        if (firstUserMsgIndex === 0) {
          const removedMsg = newMessages[0]
          const removedParentId = removedMsg.parentId
          for (let i = 1; i < newMessages.length; i++) {
            if (newMessages[i].parentId === removedMsg.id) {
              newMessages[i] = { ...newMessages[i], parentId: removedParentId }
            }
          }
          newMessages = newMessages.slice(1)
        }
      }

      if (newMessages.length === 0) return

      await this.appendMessagesToDB(
        conversationId,
        envId,
        userId,
        newMessages,
        lastRecordId,
        assistantRecordId,
        isResumeFromInterrupt,
        preSavedUserRecordId,
      )
    } finally {
      // DEBUG: copy JSONL before deletion for comparison
      try {
        const debugDir = path.resolve(cwd, 'debug-jsonl')
        await fs.mkdir(debugDir, { recursive: true })
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
        const debugPath = path.join(debugDir, `${conversationId}_before-delete_${timestamp}.jsonl`)
        await fs.copyFile(localFilePath, debugPath)
        console.error(`[DEBUG] Copied JSONL before delete to: ${debugPath}`)
      } catch {
        // debug copy failed (file may not exist), ignore
      }
      await this.cleanupLocalFile(localFilePath)
    }
  }

  private async appendMessagesToDB(
    conversationId: string,
    envId: string,
    userId: string,
    newMessages: CodeBuddyMessage[],
    lastRecordId: string | null,
    assistantRecordId?: string,
    isResumeFromInterrupt?: boolean,
    preSavedUserRecordId?: string | null,
  ): Promise<void> {
    const groups = this.groupMessages(newMessages)
    let prevRecordId = lastRecordId
    let firstAssistantGroupHandled = false
    let preSavedUserRecordHandled = false

    for (const group of groups) {
      if (group.length === 0) continue

      const firstMsg = group.find((m) => !this.isToolResultMessage(m)) || group[0]
      const role = (firstMsg.role || 'assistant') as 'user' | 'assistant'

      const primaryMsg = group.find((m) => m.type === 'message')
      const recordId = role === 'assistant' && assistantRecordId ? assistantRecordId : primaryMsg?.id || uuidv4()

      const parts: UnifiedMessagePart[] = []
      for (const msg of group) {
        parts.push(...this.extractPartsFromMessage(msg))
      }

      if (parts.length === 0) continue

      // Resume/pre-save: append to existing record
      if (
        (isResumeFromInterrupt || !!assistantRecordId) &&
        role === 'assistant' &&
        assistantRecordId &&
        !firstAssistantGroupHandled
      ) {
        await this.appendPartsToRecord(assistantRecordId, parts)
        await this.updateRecordStatus(assistantRecordId, 'done')
        firstAssistantGroupHandled = true
        continue
      }

      // Pre-saved user record
      if (preSavedUserRecordId && role === 'user' && !preSavedUserRecordHandled) {
        await this.replacePartsInRecord(preSavedUserRecordId, parts)
        await this.updateRecordStatus(preSavedUserRecordId, 'done')
        preSavedUserRecordHandled = true
        prevRecordId = preSavedUserRecordId
        continue
      }

      const record = await this.saveRecordToDB({
        recordId,
        conversationId,
        envId,
        userId,
        agentId: AGENT_ID,
        role,
        replyTo: role === 'assistant' ? (prevRecordId ?? undefined) : undefined,
        status: 'done',
        parts,
      })

      if (role === 'user') {
        prevRecordId = record.recordId
      }
    }
  }

  async preSavePendingRecords(params: {
    conversationId: string
    envId: string
    userId: string
    prompt: string
    prevRecordId: string | null
    assistantRecordId?: string
  }): Promise<{ userRecordId: string; assistantRecordId: string }> {
    const { conversationId, envId, userId, prompt, prevRecordId } = params
    const assistantRecordId = params.assistantRecordId || uuidv4()
    const userRecordId = uuidv4()

    const userParts: UnifiedMessagePart[] = [
      {
        partId: uuidv4(),
        contentType: 'text',
        content: prompt,
        metadata: {
          id: userRecordId,
          type: 'message',
          role: 'user',
          sessionId: conversationId,
          timestamp: Date.now(),
        },
      },
    ]

    await this.saveRecordToDB({
      recordId: userRecordId,
      conversationId,
      envId,
      userId,
      agentId: AGENT_ID,
      role: 'user',
      replyTo: prevRecordId || undefined,
      status: 'done',
      parts: userParts,
    })

    await this.saveRecordToDB({
      recordId: assistantRecordId,
      conversationId,
      envId,
      userId,
      agentId: AGENT_ID,
      role: 'assistant',
      replyTo: userRecordId,
      status: 'pending',
      parts: [],
    })

    return { userRecordId, assistantRecordId }
  }

  async getLatestRecordStatus(
    conversationId: string,
    userId: string,
    envId: string,
  ): Promise<{ recordId: string; status: string } | null> {
    try {
      const collection = await this.getCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      const { data } = await collection
        .where({
          conversationId: _.eq(conversationId),
          envId: _.eq(envId),
          userId: _.eq(userId),
          role: _.eq('assistant'),
        })
        .orderBy('createTime', 'desc')
        .limit(1)
        .get()

      if (!data || data.length === 0) return null

      return {
        recordId: (data[0] as any).recordId,
        status: (data[0] as any).status || 'done',
      }
    } catch {
      return null
    }
  }

  async conversationExists(conversationId: string, userId: string, envId: string): Promise<boolean> {
    try {
      const collection = await this.getCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      const { data } = await collection
        .where({
          conversationId: _.eq(conversationId),
          envId: _.eq(envId),
          userId: _.eq(userId),
        })
        .limit(1)
        .get()

      return data.length > 0
    } catch {
      return false
    }
  }

  async finalizePendingRecords(assistantRecordId: string, status: 'done' | 'error' | 'cancel'): Promise<void> {
    await this.updateRecordStatus(assistantRecordId, status)
  }

  /**
   * 更新已存在的 tool_result 记录（DB only）
   *
   * interrupt=true 时 CLI 已写入 status=incomplete 的 tool_result，
   * resume 时需要将其更新为用户实际回答的内容（而非追加新记录）
   *
   * @param conversationId 会话 ID（用于越权防护）
   * @param recordId 消息记录 ID
   * @param callId function_call 的 toolCallId
   * @param output 用户回答的内容
   * @param status 更新后的状态，默认 'completed'
   */
  async updateToolResult(
    conversationId: string,
    recordId: string,
    callId: string,
    output: string | Record<string, unknown>,
    status: string = 'completed',
  ): Promise<void> {
    const outputStr = typeof output === 'string' ? output : JSON.stringify(output)

    try {
      const collection = await this.getCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      // Find the record
      const { data } = await collection
        .where({
          conversationId: _.eq(conversationId),
          recordId: _.eq(recordId),
        })
        .limit(1)
        .get()

      if (!data || data.length === 0) return

      const record = data[0] as UnifiedMessageRecord
      const parts = [...(record.parts || [])]

      // Find and update the tool_result part
      const toolResultIndex = parts.findIndex((p) => p.contentType === 'tool_result' && p.toolCallId === callId)

      if (toolResultIndex >= 0) {
        // Update existing tool_result part
        parts[toolResultIndex] = {
          ...parts[toolResultIndex],
          content: outputStr,
          metadata: {
            ...(parts[toolResultIndex].metadata || {}),
            status,
          },
        }
      } else {
        // Find tool_call part and add tool_result
        const toolCallIndex = parts.findIndex((p) => p.contentType === 'tool_call' && p.toolCallId === callId)

        if (toolCallIndex >= 0) {
          // Add tool_result part
          parts.push({
            partId: uuidv4(),
            contentType: 'tool_result',
            toolCallId: callId,
            content: outputStr,
            metadata: { status },
          })
        }
      }

      // Update the record
      await collection
        .where({
          conversationId: _.eq(conversationId),
          recordId: _.eq(recordId),
        })
        .update({
          parts,
          updateTime: Date.now(),
        })
    } catch (error) {
      console.error('Failed to update tool result:', error)
    }
  }

  /**
   * 获取对话历史，返回消息列表和工具调用列表
   */
  async getChatHistory(
    conversationId: string,
    envId: string,
    userId: string,
  ): Promise<{
    messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }>
    toolCalls: Array<{
      id: string
      name: string
      input: Record<string, unknown>
      output?: string
      status: 'completed' | 'error'
    }>
  }> {
    const records = await this.loadDBMessages(conversationId, envId, userId)

    const messages: Array<{ id: string; role: 'user' | 'assistant'; content: string; timestamp: number }> = []
    const toolCallMap = new Map<
      string,
      { id: string; name: string; input: Record<string, unknown>; output?: string; status: 'completed' | 'error' }
    >()

    for (const record of records) {
      const role = record.role as 'user' | 'assistant'
      const timestamp = record.createTime || Date.now()

      for (const part of record.parts || []) {
        if (part.contentType === 'text') {
          const content = part.content || ''
          if (content) {
            messages.push({ id: record.recordId, role, content, timestamp })
          }
        } else if (part.contentType === 'tool_call' && part.toolCallId) {
          const metadata = part.metadata as Record<string, unknown> | undefined
          const toolName = (metadata?.toolCallName as string) || ''
          let input: Record<string, unknown> = {}
          if (part.content) {
            try {
              input = JSON.parse(part.content)
            } catch {
              // keep empty
            }
          }
          toolCallMap.set(part.toolCallId, {
            id: part.toolCallId,
            name: toolName,
            input,
            status: 'completed',
          })
        } else if (part.contentType === 'tool_result' && part.toolCallId) {
          const existing = toolCallMap.get(part.toolCallId)
          const metadata = part.metadata as Record<string, unknown> | undefined
          const isError = metadata?.status === 'error'
          if (existing) {
            existing.output = part.content || ''
            existing.status = isError ? 'error' : 'completed'
          } else {
            toolCallMap.set(part.toolCallId, {
              id: part.toolCallId,
              name: '',
              input: {},
              output: part.content || '',
              status: isError ? 'error' : 'completed',
            })
          }
        }
      }
    }

    return {
      messages,
      toolCalls: Array.from(toolCallMap.values()),
    }
  }

  /**
   * 获取工具调用信息（用于 resume 时手动执行工具）
   *
   * @param conversationId 会话 ID
   * @param recordId 消息记录 ID
   * @param callId function_call 的 toolCallId
   * @returns 工具名称和参数，或 null
   */
  async getToolCallInfo(
    conversationId: string,
    recordId: string,
    callId: string,
  ): Promise<{ toolName: string; input: Record<string, unknown> } | null> {
    try {
      const collection = await this.getCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      const { data } = await collection
        .where({
          conversationId: _.eq(conversationId),
          recordId: _.eq(recordId),
        })
        .limit(1)
        .get()

      if (!data || data.length === 0) return null

      const record = data[0] as UnifiedMessageRecord
      const parts = record.parts || []

      // Find tool_call part
      const toolCallPart = parts.find((p) => p.contentType === 'tool_call' && p.toolCallId === callId)

      if (!toolCallPart) return null

      const metadata = toolCallPart.metadata as Record<string, unknown> | undefined
      const toolName = metadata?.toolCallName as string | undefined
      const inputStr = toolCallPart.content
      let input: Record<string, unknown> = {}

      if (inputStr) {
        try {
          input = JSON.parse(inputStr)
        } catch {
          // 解析失败，保持空对象
        }
      }

      return toolName ? { toolName, input } : null
    } catch {
      return null
    }
  }

  /**
   * 删除指定会话的所有消息记录
   *
   * @param conversationId 会话 ID
   * @param envId 用户环境 ID
   * @param userId 用户 ID
   */
  async deleteConversationMessages(conversationId: string, envId: string, userId: string): Promise<void> {
    try {
      const collection = await this.getCollection()
      const app = await this.getCloudBaseApp()
      const _ = app.database().command

      await collection
        .where({
          conversationId: _.eq(conversationId),
          envId: _.eq(envId),
          userId: _.eq(userId),
          agentId: _.eq(AGENT_ID),
        })
        .remove()
    } catch {
      // 删除失败不影响主流程，仅记录服务端日志
      console.error('Failed to delete conversation messages')
    }
  }
}

// Export singleton
export const persistenceService = new PersistenceService()
