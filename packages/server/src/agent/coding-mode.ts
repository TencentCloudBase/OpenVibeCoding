import type { SandboxInstance } from '../sandbox/scf-sandbox-manager.js'

const TEMPLATE_REPO = 'https://github.com/TencentCloudBase/awesome-cloudbase-examples.git'
const TEMPLATE_SUBDIR = 'web/cloudbase-react-template'
const DEV_SERVER_PORT = 5173

/**
 * Initialize a coding project in the sandbox workspace from the CloudBase React template.
 * Clones the template repo, copies the subdir to the workspace, and installs dependencies.
 */
export async function initCodingProject(sandbox: SandboxInstance, workspace: string): Promise<void> {
  // Check if project already initialized (package.json exists)
  const checkRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `test -f "${workspace}/package.json" && echo "exists" || echo "not_found"`,
      timeout: 5000,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  const checkData = (await checkRes.json()) as { result?: { output?: string } }
  if (checkData.result?.output?.trim() === 'exists') {
    console.log('[CodingMode] Project already initialized')
    return
  }

  // Clone template repo (sparse checkout for the specific subdir)
  console.log('[CodingMode] Initializing project from template')
  const initScript = [
    `cd /tmp`,
    `git clone --depth 1 --filter=blob:none --sparse ${TEMPLATE_REPO} _template_repo 2>&1 || true`,
    `cd _template_repo`,
    `git sparse-checkout set ${TEMPLATE_SUBDIR} 2>&1`,
    `cp -r ${TEMPLATE_SUBDIR}/. "${workspace}/"`,
    `cd /tmp && rm -rf _template_repo`,
  ].join(' && ')

  const cloneRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command: initScript, timeout: 60000 }),
    signal: AbortSignal.timeout(120_000),
  })

  if (!cloneRes.ok) {
    throw new Error('Failed to clone template')
  }

  // Install dependencies
  console.log('[CodingMode] Installing dependencies')
  const installRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `cd "${workspace}" && npm install 2>&1`,
      timeout: 120000,
    }),
    signal: AbortSignal.timeout(180_000),
  })

  if (!installRes.ok) {
    throw new Error('Failed to install dependencies')
  }

  console.log('[CodingMode] Project initialized')
}

/**
 * Start the Vite dev server in the background inside the sandbox.
 * Returns once the server is confirmed running.
 */
export async function startDevServer(sandbox: SandboxInstance, workspace: string): Promise<void> {
  // Check if dev server is already running
  const checkRes = await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `curl -s -o /dev/null -w "%{http_code}" http://localhost:${DEV_SERVER_PORT}/ 2>/dev/null || echo "0"`,
      timeout: 5000,
    }),
    signal: AbortSignal.timeout(10_000),
  })

  const checkData = (await checkRes.json()) as { result?: { output?: string } }
  const statusCode = checkData.result?.output?.trim()
  if (statusCode === '200' || statusCode === '304') {
    console.log('[CodingMode] Dev server already running')
    return
  }

  // Start dev server in background
  console.log('[CodingMode] Starting dev server')
  await sandbox.request('/api/tools/bash', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      command: `cd "${workspace}" && nohup npm run dev > /tmp/devserver.log 2>&1 &`,
      timeout: 10000,
    }),
    signal: AbortSignal.timeout(15_000),
  })

  // Wait for dev server to be ready (poll up to 30s)
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    try {
      const pollRes = await sandbox.request('/api/tools/bash', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: `curl -s -o /dev/null -w "%{http_code}" http://localhost:${DEV_SERVER_PORT}/ 2>/dev/null || echo "0"`,
          timeout: 5000,
        }),
        signal: AbortSignal.timeout(10_000),
      })
      const pollData = (await pollRes.json()) as { result?: { output?: string } }
      const code = pollData.result?.output?.trim()
      if (code === '200' || code === '304') {
        console.log('[CodingMode] Dev server ready')
        return
      }
    } catch {
      // continue polling
    }
  }

  console.log('[CodingMode] Dev server may not be ready, continuing anyway')
}

/**
 * Returns the system prompt that constrains the agent to the coding tech stack.
 */
export function getCodingSystemPrompt(): string {
  return `You are a frontend coding assistant. You are working on a React project with the following tech stack:

- React 18 + TypeScript
- Vite (dev server and build tool)
- Tailwind CSS (utility-first CSS framework)
- DaisyUI (Tailwind component library)
- React Router (client-side routing)
- Framer Motion (animations)

IMPORTANT RULES:
1. Only use the above technologies. Do NOT introduce new frameworks or libraries unless explicitly asked.
2. Use Tailwind CSS classes and DaisyUI components for all styling. Do NOT write custom CSS unless absolutely necessary.
3. All new components should be placed in src/components/.
4. All new pages should be placed in src/pages/ and registered in src/App.jsx routes.
5. Use functional components with hooks. Do NOT use class components.
6. Keep the code clean and well-structured. Use TypeScript for new files (.tsx/.ts).
7. After modifying code, the dev server will auto-reload via Vite HMR — no need to restart it.
8. When creating new UI, prefer DaisyUI components (btn, card, modal, navbar, etc.) over building from scratch.`
}

export const CODING_DEV_SERVER_PORT = DEV_SERVER_PORT
