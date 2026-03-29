import { execFile } from "node:child_process"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
export const SCRIPTS_DIR = join(__dirname, "..", "sommeliagent", "scripts")

const ALLOWED_SCRIPTS = new Set(["recommend.py", "rate.py", "auth.py", "history.py"])

export function runScript(
  scriptName: string,
  args: string[],
  timeout: number = 30_000,
): Promise<{ stdout: string; stderr: string }> {
  if (!ALLOWED_SCRIPTS.has(scriptName)) {
    return Promise.reject(new Error(`Unknown script: ${scriptName}`))
  }
  return new Promise((resolve, reject) => {
    execFile(
      "uv",
      ["run", join(SCRIPTS_DIR, scriptName), ...args],
      { timeout, maxBuffer: 1024 * 512 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`${scriptName} failed: ${stderr || error.message}`))
        } else {
          resolve({ stdout, stderr })
        }
      },
    )
  })
}
