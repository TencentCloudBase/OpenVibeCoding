/**
 * CLI prompts for init / setup scripts.
 * Secret fields use @inquirer/password (masked with *).
 */

import readline from 'node:readline'
import password from '@inquirer/password'

let _rl = null

function drainStdin() {
  return new Promise((resolve) => {
    if (!process.stdin.readable) return resolve()
    process.stdin.resume()
    const drain = () => {
      while (process.stdin.read() !== null) {
        /* discard */
      }
    }
    drain()
    setTimeout(() => {
      drain()
      process.stdin.pause()
      resolve()
    }, 10)
  })
}

async function closeReadlineInterface() {
  if (_rl) {
    _rl.close()
    _rl = null
  }
  await drainStdin()
}

/**
 * @param {string} prompt
 * @param {boolean | { hidden?: boolean, defaultValue?: string }} hiddenOrOptions
 */
export async function promptInput(prompt, hiddenOrOptions = false) {
  const opts =
    typeof hiddenOrOptions === 'object'
      ? hiddenOrOptions
      : { hidden: Boolean(hiddenOrOptions), defaultValue: '' }
  const { hidden = false, defaultValue = '' } = opts

  if (hidden) {
    await closeReadlineInterface()
    const value = await password({
      message: prompt,
      mask: '*',
    })
    return (value ?? '').trim() || defaultValue
  }

  await closeReadlineInterface()
  _rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    _rl.question(`${prompt}: `, (answer) => {
      _rl.close()
      _rl = null
      resolve(answer.trim() || defaultValue)
    })
  })
}

/** Call at script exit if the process may keep running (e.g. uncaught handler). */
export function closeReadline() {
  if (_rl) {
    _rl.close()
    _rl = null
  }
}
