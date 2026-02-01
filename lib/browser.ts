import { exec } from "node:child_process"
import { platform } from "node:os"

export function openInBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let command: string

    switch (platform()) {
      case "darwin":
        command = `open "${url}"`
        break
      case "win32":
        command = `start "" "${url}"`
        break
      default:
        command = `xdg-open "${url}"`
    }

    exec(command, (error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}
